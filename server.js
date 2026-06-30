"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

const BINANCE_FUTURES_BASE_URL =
  process.env.BINANCE_FUTURES_BASE_URL || "https://fapi.binance.com";
const BINANCE_SPOT_BASE_URL =
  process.env.BINANCE_SPOT_BASE_URL || "https://api.binance.com";

const EXCHANGE_INFO_TTL_MS = 6 * 60 * 60 * 1000;
const TICKER_TTL_MS = 20 * 1000;
const REQUEST_TIMEOUT_MS = 8000;

const CONFIG = Object.freeze({
  winRate: 0.3,
  notionalUsdt: 10000,
  maxLossUsdt: 650,
  defaultCostBufferPct: 0.12,
  minAverageR: 0.7 / 0.3,
  quotePreference: ["USDT", "USDC", "BUSD", "USD"]
});

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const symbolAliases = new Map([
  ["BITCOIN", "BTC"],
  ["BTC", "BTC"],
  ["比特幣", "BTC"],
  ["比特币", "BTC"],
  ["ETHEREUM", "ETH"],
  ["ETHER", "ETH"],
  ["ETH", "ETH"],
  ["以太坊", "ETH"],
  ["SOLANA", "SOL"],
  ["SOL", "SOL"],
  ["索拉納", "SOL"],
  ["索拉纳", "SOL"],
  ["RIPPLE", "XRP"],
  ["XRP", "XRP"],
  ["瑞波", "XRP"],
  ["DOGECOIN", "DOGE"],
  ["DOGE", "DOGE"],
  ["狗狗幣", "DOGE"],
  ["狗狗币", "DOGE"],
  ["BINANCECOIN", "BNB"],
  ["BNB", "BNB"],
  ["CARDANO", "ADA"],
  ["ADA", "ADA"],
  ["CHAINLINK", "LINK"],
  ["LINK", "LINK"],
  ["LITECOIN", "LTC"],
  ["LTC", "LTC"],
  ["AVALANCHE", "AVAX"],
  ["AVAX", "AVAX"],
  ["POLYGON", "POL"],
  ["MATIC", "POL"],
  ["POL", "POL"],
  ["TRON", "TRX"],
  ["TRX", "TRX"],
  ["TONCOIN", "TON"],
  ["TON", "TON"],
  ["HYPERLIQUID", "HYPE"],
  ["HYPE", "HYPE"]
]);

const exchangeInfoCache = new Map();
const tickerCache = new Map();

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function safeJoinStaticPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath.split("?")[0]);
  const normalizedPath =
    decodedPath === "/"
      ? "index.html"
      : path.normalize(decodedPath).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalizedPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }
  return filePath;
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error("Payload too large.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "crypto-trade-decision-desk/1.0"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = JSON.parse(text).msg || text;
      } catch {
        // Keep the original response text.
      }
      throw new Error(`Binance API ${response.status}: ${message}`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSymbolInput(input) {
  const raw = String(input || "").trim();
  const compact = raw
    .toUpperCase()
    .replace(/[\s/_-]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return symbolAliases.get(compact) || compact;
}

function getMarketConfig(market) {
  if (market === "spot") {
    return {
      key: "spot",
      baseUrl: BINANCE_SPOT_BASE_URL,
      exchangeInfoPath: "/api/v3/exchangeInfo",
      tickerPath: "/api/v3/ticker/price",
      ticker24hPath: "/api/v3/ticker/24hr"
    };
  }
  return {
    key: "futures",
    baseUrl: BINANCE_FUTURES_BASE_URL,
    exchangeInfoPath: "/fapi/v1/exchangeInfo",
    tickerPath: "/fapi/v1/ticker/price",
    ticker24hPath: "/fapi/v1/ticker/24hr"
  };
}

async function getExchangeInfo(market) {
  const cfg = getMarketConfig(market);
  const cached = exchangeInfoCache.get(cfg.key);
  if (cached && Date.now() - cached.time < EXCHANGE_INFO_TTL_MS) {
    return cached.data;
  }

  const data = await fetchJson(`${cfg.baseUrl}${cfg.exchangeInfoPath}`);
  const symbols = Array.isArray(data.symbols) ? data.symbols : [];
  exchangeInfoCache.set(cfg.key, { time: Date.now(), data: symbols });
  return symbols;
}

function isTradableSymbol(info, market) {
  if (!info || info.status !== "TRADING") return false;
  if (market !== "spot" && info.contractType && info.contractType !== "PERPETUAL") {
    return false;
  }
  return true;
}

function symbolPriority(info) {
  const quoteIndex = CONFIG.quotePreference.indexOf(info.quoteAsset);
  return quoteIndex === -1 ? CONFIG.quotePreference.length : quoteIndex;
}

async function resolveSymbol(input, market) {
  const normalized = normalizeSymbolInput(input);
  if (!normalized) {
    throw new Error("請輸入幣種，例如 BTC、ETH、SOL 或 BTCUSDT。");
  }

  const symbols = await getExchangeInfo(market);
  const tradable = symbols.filter((item) => isTradableSymbol(item, market));
  const exact = tradable.find((item) => item.symbol === normalized);
  if (exact) return exact;

  const withPreferredQuote = CONFIG.quotePreference
    .map((quote) => tradable.find((item) => item.symbol === `${normalized}${quote}`))
    .find(Boolean);
  if (withPreferredQuote) return withPreferredQuote;

  const baseMatches = tradable
    .filter((item) => item.baseAsset === normalized)
    .sort((a, b) => symbolPriority(a) - symbolPriority(b));
  if (baseMatches.length) return baseMatches[0];

  const fuzzy = tradable
    .filter((item) => item.symbol.startsWith(normalized))
    .sort((a, b) => symbolPriority(a) - symbolPriority(b));
  if (fuzzy.length) return fuzzy[0];

  throw new Error(`找不到 ${input} 的 Binance ${market === "spot" ? "現貨" : "USDT 永續"}交易對。`);
}

async function getTicker(symbolInfo, market) {
  const cfg = getMarketConfig(market);
  const cacheKey = `${cfg.key}:${symbolInfo.symbol}`;
  const cached = tickerCache.get(cacheKey);
  if (cached && Date.now() - cached.time < TICKER_TTL_MS) {
    return cached.data;
  }

  const query = `symbol=${encodeURIComponent(symbolInfo.symbol)}`;
  const [priceData, dayData] = await Promise.all([
    fetchJson(`${cfg.baseUrl}${cfg.tickerPath}?${query}`),
    fetchJson(`${cfg.baseUrl}${cfg.ticker24hPath}?${query}`)
  ]);

  const price = Number(priceData.price || dayData.lastPrice);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`取得 ${symbolInfo.symbol} 價格失敗。`);
  }

  const data = {
    market,
    symbol: symbolInfo.symbol,
    baseAsset: symbolInfo.baseAsset,
    quoteAsset: symbolInfo.quoteAsset,
    currentPrice: price,
    priceChangePercent24h: toFiniteNumber(dayData.priceChangePercent),
    highPrice24h: toFiniteNumber(dayData.highPrice),
    lowPrice24h: toFiniteNumber(dayData.lowPrice),
    quoteVolume24h: toFiniteNumber(dayData.quoteVolume),
    fetchedAt: new Date().toISOString()
  };

  tickerCache.set(cacheKey, { time: Date.now(), data });
  return data;
}

async function getMarketData(input, market) {
  const preferredMarket = market === "spot" ? "spot" : "futures";
  try {
    const symbolInfo = await resolveSymbol(input, preferredMarket);
    return getTicker(symbolInfo, preferredMarket);
  } catch (error) {
    if (preferredMarket === "futures") {
      const spotInfo = await resolveSymbol(input, "spot");
      return getTicker(spotInfo, "spot");
    }
    throw error;
  }
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value, digits = 6) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundMoney(value) {
  return round(value, 2);
}

function pct(value) {
  return round(value * 100, 3);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function directionSign(direction) {
  return direction === "short" ? -1 : 1;
}

function validateTradeShape(direction, entry, stopLoss, tps) {
  const errors = [];
  const sign = directionSign(direction);

  if (direction !== "long" && direction !== "short") {
    errors.push("方向必須選擇做多或做空。");
  }

  if (direction === "long") {
    if (!(stopLoss < entry)) errors.push("做多時止損必須低於進場價。");
    if (!tps.every((tp) => tp > entry)) errors.push("做多時 TP1/TP2/TP3 都必須高於進場價。");
    if (!(tps[0] <= tps[1] && tps[1] <= tps[2])) {
      errors.push("做多時 TP 價格應由低到高排列。");
    }
  }

  if (direction === "short") {
    if (!(stopLoss > entry)) errors.push("做空時止損必須高於進場價。");
    if (!tps.every((tp) => tp < entry)) errors.push("做空時 TP1/TP2/TP3 都必須低於進場價。");
    if (!(tps[0] >= tps[1] && tps[1] >= tps[2])) {
      errors.push("做空時 TP 價格應由高到低排列。");
    }
  }

  const profitDistances = tps.map((tp) => sign * (tp - entry));
  if (profitDistances.some((distance) => distance <= 0)) {
    errors.push("TP 價格與方向不符，無法計算有效獲利。");
  }

  return errors;
}

function allocateTakeProfitWeights(tpRewardsR) {
  const minimums = [0.15, 0.2, 0.25];
  const variablePool = 1 - minimums.reduce((sum, item) => sum + item, 0);
  const scores = tpRewardsR.map((value, index) => {
    const runnerBonus = index === 2 ? 1.12 : 1;
    return Math.pow(Math.max(value, 0.05), 1.15) * runnerBonus;
  });
  const totalScore = scores.reduce((sum, item) => sum + item, 0) || 1;
  return minimums.map((minimum, index) =>
    minimum + variablePool * (scores[index] / totalScore)
  );
}

function evaluateTradeCore({ direction, entry, stopLoss, tps, costBufferPct }) {
  const sign = directionSign(direction);
  const costBufferRate = clamp(costBufferPct, 0, 2) / 100;
  const estimatedCostsUsdt = CONFIG.notionalUsdt * costBufferRate;
  const maxPriceRiskUsdt = Math.max(CONFIG.maxLossUsdt - estimatedCostsUsdt, 0);
  const maxPriceRiskPct = maxPriceRiskUsdt / CONFIG.notionalUsdt;
  const riskDistance = Math.abs(entry - stopLoss);
  const priceRiskPct = riskDistance / entry;
  const priceRiskUsdt = CONFIG.notionalUsdt * priceRiskPct;
  const grossRiskUsdt = priceRiskUsdt + estimatedCostsUsdt;

  const tpRewards = tps.map((target) => {
    const movePct = Math.abs(target - entry) / entry;
    const fullPositionProfitUsdt = CONFIG.notionalUsdt * movePct;
    return {
      price: target,
      movePct,
      fullPositionProfitUsdt,
      rMultiple: grossRiskUsdt > 0 ? fullPositionProfitUsdt / grossRiskUsdt : 0
    };
  });

  const weights = allocateTakeProfitWeights(tpRewards.map((item) => item.rMultiple));
  const positionQty = CONFIG.notionalUsdt / entry;
  const tpPlan = tpRewards.map((item, index) => {
    const closeWeight = weights[index];
    const sliceProfitUsdt = item.fullPositionProfitUsdt * closeWeight;
    return {
      label: `TP${index + 1}`,
      price: item.price,
      closePercent: pct(closeWeight),
      closeFraction: closeWeight,
      closeNotionalUsdt: roundMoney(CONFIG.notionalUsdt * closeWeight),
      closeQty: round(positionQty * closeWeight, 8),
      profitUsdt: roundMoney(sliceProfitUsdt),
      movePct: pct(item.movePct),
      rMultiple: round(item.rMultiple, 3)
    };
  });

  const weightedGrossProfitUsdt = tpRewards.reduce(
    (sum, item, index) => sum + item.fullPositionProfitUsdt * weights[index],
    0
  );
  const netWinnerUsdt = weightedGrossProfitUsdt - estimatedCostsUsdt;
  const averageR = grossRiskUsdt > 0 ? netWinnerUsdt / grossRiskUsdt : 0;
  const expectedValueUsdt =
    CONFIG.winRate * netWinnerUsdt - (1 - CONFIG.winRate) * grossRiskUsdt;

  const oneRPrice = entry + sign * riskDistance;
  const halfRiskStop = entry - sign * riskDistance * 0.5;
  const breakevenStop = entry + sign * entry * costBufferRate;
  const lockAfterTp2Stop = tps[0];

  return {
    direction,
    entry,
    stopLoss,
    tps,
    positionQty: round(positionQty, 8),
    riskDistance: round(riskDistance, 8),
    priceRiskPct: pct(priceRiskPct),
    priceRiskUsdt: roundMoney(priceRiskUsdt),
    estimatedCostsUsdt: roundMoney(estimatedCostsUsdt),
    grossRiskUsdt: roundMoney(grossRiskUsdt),
    maxPriceRiskPct: pct(maxPriceRiskPct),
    maxPriceRiskUsdt: roundMoney(maxPriceRiskUsdt),
    weightedGrossProfitUsdt: roundMoney(weightedGrossProfitUsdt),
    netWinnerUsdt: roundMoney(netWinnerUsdt),
    averageR: round(averageR, 3),
    requiredR: round(CONFIG.minAverageR, 3),
    expectedValueUsdt: roundMoney(expectedValueUsdt),
    tpPlan,
    stopPlan: [
      {
        trigger: "1R",
        triggerPrice: round(oneRPrice, 8),
        action: "先把止損縮到原風險的一半，避免一筆單從浮盈變成滿額虧損。",
        newStop: round(halfRiskStop, 8)
      },
      {
        trigger: "TP1",
        triggerPrice: tps[0],
        action:
          tpRewards[0].rMultiple >= 1
            ? "平掉 TP1 倉位後，止損移到含成本保本價。"
            : "TP1 小於 1R，只先收部分倉位；等價格到 1R 再移動止損。",
        newStop: round(tpRewards[0].rMultiple >= 1 ? breakevenStop : halfRiskStop, 8)
      },
      {
        trigger: "TP2",
        triggerPrice: tps[1],
        action: "平掉 TP2 倉位後，把止損移到 TP1 附近，讓剩餘倉位至少鎖住部分利潤。",
        newStop: round(lockAfterTp2Stop, 8)
      },
      {
        trigger: "TP3",
        triggerPrice: tps[2],
        action: "平掉剩餘倉位，這筆計畫結束，不追價加碼。",
        newStop: null
      }
    ]
  };
}

function stopBoundaryForRisk(direction, entry, maxPriceRiskPct) {
  if (direction === "short") {
    return entry * (1 + maxPriceRiskPct);
  }
  return entry * (1 - maxPriceRiskPct);
}

function entryBoundaryForRisk(direction, stopLoss, maxPriceRiskPct) {
  if (maxPriceRiskPct <= 0) return null;
  if (direction === "short") {
    return stopLoss / (1 + maxPriceRiskPct);
  }
  return stopLoss / (1 - maxPriceRiskPct);
}

function canEvaluateAtEntry(direction, candidateEntry, stopLoss, tps) {
  if (!Number.isFinite(candidateEntry) || candidateEntry <= 0) return false;
  return validateTradeShape(direction, candidateEntry, stopLoss, tps).length === 0;
}

function findSuggestedEntry({ direction, entry, stopLoss, tps, costBufferPct }) {
  const evaluation = evaluateTradeCore({ direction, entry, stopLoss, tps, costBufferPct });
  const sign = directionSign(direction);
  const maxPriceRiskPct = evaluation.maxPriceRiskUsdt / CONFIG.notionalUsdt;
  const riskBoundary = entryBoundaryForRisk(direction, stopLoss, maxPriceRiskPct);
  const steps = 1800;

  if (direction === "long") {
    const lowerBound = stopLoss * 1.0002;
    const upperBound = Math.min(entry, tps[0] * 0.9998);
    for (let index = 0; index <= steps; index += 1) {
      const candidate = upperBound - ((upperBound - lowerBound) * index) / steps;
      if (!canEvaluateAtEntry(direction, candidate, stopLoss, tps)) continue;
      const metrics = evaluateTradeCore({ direction, entry: candidate, stopLoss, tps, costBufferPct });
      if (
        metrics.grossRiskUsdt <= CONFIG.maxLossUsdt &&
        metrics.averageR >= CONFIG.minAverageR
      ) {
        return {
          price: round(candidate, 8),
          instruction: "做多要等更靠近止損的回撤價，降低風險並拉高平均 R。",
          riskBoundary: riskBoundary ? round(riskBoundary, 8) : null,
          projectedAverageR: metrics.averageR,
          projectedGrossRiskUsdt: metrics.grossRiskUsdt
        };
      }
    }
  } else {
    const lowerBound = Math.max(entry, tps[0] * 1.0002);
    const upperBound = stopLoss * 0.9998;
    for (let index = 0; index <= steps; index += 1) {
      const candidate = lowerBound + ((upperBound - lowerBound) * index) / steps;
      if (!canEvaluateAtEntry(direction, candidate, stopLoss, tps)) continue;
      const metrics = evaluateTradeCore({ direction, entry: candidate, stopLoss, tps, costBufferPct });
      if (
        metrics.grossRiskUsdt <= CONFIG.maxLossUsdt &&
        metrics.averageR >= CONFIG.minAverageR
      ) {
        return {
          price: round(candidate, 8),
          instruction: "做空要等反彈到更靠近止損的位置，降低風險並拉高平均 R。",
          riskBoundary: riskBoundary ? round(riskBoundary, 8) : null,
          projectedAverageR: metrics.averageR,
          projectedGrossRiskUsdt: metrics.grossRiskUsdt
        };
      }
    }
  }

  return {
    price: null,
    instruction:
      sign === 1
        ? "以目前止損與 TP 組合，找不到同時符合最大虧損與 30% 勝率期望值的做多掛單價。"
        : "以目前止損與 TP 組合，找不到同時符合最大虧損與 30% 勝率期望值的做空掛單價。",
    riskBoundary: riskBoundary ? round(riskBoundary, 8) : null,
    projectedAverageR: null,
    projectedGrossRiskUsdt: null
  };
}

function analyzeTrade(payload, marketData) {
  const direction = payload.direction === "short" ? "short" : "long";
  const entry = toPositiveNumber(payload.entryPrice) || marketData.currentPrice;
  const stopLoss = toPositiveNumber(payload.stopLoss);
  const tps = [payload.tp1, payload.tp2, payload.tp3].map(toPositiveNumber);
  const costBufferPct =
    toFiniteNumber(payload.costBufferPct) === null
      ? CONFIG.defaultCostBufferPct
      : clamp(Number(payload.costBufferPct), 0, 2);

  const errors = [];
  if (!entry) errors.push("進場價或市場價無效。");
  if (!stopLoss) errors.push("請輸入有效止損價。");
  if (tps.some((tp) => !tp)) errors.push("請完整輸入 TP1、TP2、TP3。");

  if (errors.length) {
    return {
      ok: false,
      decision: "資料不足",
      status: "INVALID",
      reasons: errors,
      warnings: [],
      config: publicConfig(costBufferPct),
      marketData
    };
  }

  errors.push(...validateTradeShape(direction, entry, stopLoss, tps));
  if (errors.length) {
    return {
      ok: false,
      decision: "不建議做",
      status: "INVALID",
      reasons: errors,
      warnings: [],
      config: publicConfig(costBufferPct),
      marketData,
      input: { direction, entry, stopLoss, tps }
    };
  }

  const metrics = evaluateTradeCore({ direction, entry, stopLoss, tps, costBufferPct });
  const reasons = [];
  const warnings = [];

  if (metrics.grossRiskUsdt > CONFIG.maxLossUsdt) {
    const allowedStop = stopBoundaryForRisk(
      direction,
      entry,
      metrics.maxPriceRiskUsdt / CONFIG.notionalUsdt
    );
    reasons.push(
      `止損距離造成預估最大虧損 ${metrics.grossRiskUsdt}U，超過你的上限 ${CONFIG.maxLossUsdt}U。`
    );
    reasons.push(
      direction === "long"
        ? `以此進場價計算，止損不能低於 ${round(allowedStop, 8)}。`
        : `以此進場價計算，止損不能高於 ${round(allowedStop, 8)}。`
    );
  }

  if (metrics.averageR < CONFIG.minAverageR) {
    reasons.push(
      `30% 勝率至少需要平均獲利 ${metrics.requiredR}R；這組 TP 配置只有 ${metrics.averageR}R。`
    );
  }

  if (metrics.expectedValueUsdt < 0) {
    reasons.push(`這筆單的期望值約 ${metrics.expectedValueUsdt}U，長期做同類型單不划算。`);
  }

  const tp1 = metrics.tpPlan[0];
  if (tp1 && tp1.rMultiple < 1) {
    warnings.push("TP1 低於 1R，第一段不要平太大，否則會拖低整筆單的期望值。");
  }
  if (metrics.priceRiskPct > 5) {
    warnings.push("止損距離超過 5%，波動容忍較寬，進場前要確認不是追在區間中間。");
  }
  if (marketData.market === "spot") {
    warnings.push("這個交易對未抓到 Binance USDT 永續，已改用現貨行情做估算。");
  }

  const ok = reasons.length === 0;
  if (ok) {
    reasons.push(
      `風險 ${metrics.grossRiskUsdt}U 低於 ${CONFIG.maxLossUsdt}U，平均獲利 ${metrics.averageR}R 高於 30% 勝率門檻。`
    );
    if (metrics.averageR < 2.6) {
      warnings.push("這筆單剛過門檻，成交後不適合臨場放寬止損或提前大幅止盈。");
    }
  }

  return {
    ok,
    decision: ok ? "可以做" : "不建議做",
    status: ok ? "TRADE_OK" : "NO_TRADE",
    reasons,
    warnings,
    config: publicConfig(costBufferPct),
    marketData,
    input: {
      direction,
      entry,
      entrySource: payload.entryPrice ? "custom" : "market",
      stopLoss,
      tps
    },
    metrics,
    suggestion: ok
      ? null
      : findSuggestedEntry({ direction, entry, stopLoss, tps, costBufferPct })
  };
}

function publicConfig(costBufferPct) {
  return {
    winRatePct: pct(CONFIG.winRate),
    notionalUsdt: CONFIG.notionalUsdt,
    maxLossUsdt: CONFIG.maxLossUsdt,
    costBufferPct,
    minAverageR: round(CONFIG.minAverageR, 3)
  };
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        service: "crypto-trade-decision-desk",
        port: PORT,
        time: new Date().toISOString()
      });
    }

    if (req.method === "GET" && url.pathname === "/api/market") {
      const symbol = url.searchParams.get("symbol");
      const market = url.searchParams.get("market") === "spot" ? "spot" : "futures";
      const data = await getMarketData(symbol, market);
      return sendJson(res, 200, { ok: true, data });
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readRequestBody(req);
      const payload = body ? JSON.parse(body) : {};
      const market = payload.market === "spot" ? "spot" : "futures";
      const marketData = await getMarketData(payload.coin, market);
      const analysis = analyzeTrade(payload, marketData);
      return sendJson(res, 200, { ok: true, analysis });
    }

    return sendJson(res, 404, { ok: false, error: "API route not found." });
  } catch (error) {
    return sendJson(res, 400, {
      ok: false,
      error: error.message || "Request failed."
    });
  }
}

function serveStatic(req, res, url) {
  const filePath = safeJoinStaticPath(url.pathname);
  if (!filePath) {
    return sendText(res, 403, "Forbidden");
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      return sendText(res, 404, "Not found");
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url);
    return;
  }
  serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Crypto Trade Decision Desk listening on http://${HOST}:${PORT}`);
});
