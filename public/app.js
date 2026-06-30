"use strict";

const form = document.getElementById("tradeForm");
const fetchMarketButton = document.getElementById("fetchMarketButton");
const resetButton = document.getElementById("resetButton");
const directionInput = document.getElementById("directionInput");
const segmentButtons = document.querySelectorAll(".segment");
const marketStatus = document.getElementById("marketStatus");
const resultsGrid = document.getElementById("resultsGrid");
const decisionPanel = document.getElementById("decisionPanel");
const decisionTitle = document.getElementById("decisionTitle");
const decisionStats = document.getElementById("decisionStats");
const reasonList = document.getElementById("reasonList");
const warningList = document.getElementById("warningList");
const suggestionBox = document.getElementById("suggestionBox");
const tpTableBody = document.getElementById("tpTableBody");
const stopTableBody = document.getElementById("stopTableBody");
const exportButton = document.getElementById("exportButton");
const clearHistoryButton = document.getElementById("clearHistoryButton");
const historyList = document.getElementById("historyList");

const quoteEls = {
  price: document.getElementById("quotePrice"),
  symbol: document.getElementById("quoteSymbol"),
  change: document.getElementById("quoteChange"),
  range: document.getElementById("quoteRange"),
  time: document.getElementById("quoteTime")
};

const HISTORY_KEY = "crypto-trade-decision-history-v1";
let latestMarketData = null;

function getFormValue(name) {
  const field = form.elements[name];
  return field ? field.value.trim() : "";
}

function payloadFromForm() {
  return {
    coin: getFormValue("coin"),
    market: getFormValue("market") || "futures",
    direction: directionInput.value,
    entryPrice: getFormValue("entryPrice"),
    stopLoss: getFormValue("stopLoss"),
    tp1: getFormValue("tp1"),
    tp2: getFormValue("tp2"),
    tp3: getFormValue("tp3"),
    costBufferPct: getFormValue("costBufferPct")
  };
}

function money(value, digits = 2) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}U`;
}

function price(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const number = Number(value);
  const digits = number >= 100 ? 2 : number >= 1 ? 4 : 8;
  return number.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  });
}

function qty(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8
  });
}

function pct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3
  })}%`;
}

function setBusy(isBusy, label = "處理中") {
  form.classList.toggle("is-busy", isBusy);
  document.getElementById("analyzeButton").disabled = isBusy;
  fetchMarketButton.disabled = isBusy;
  marketStatus.textContent = isBusy ? label : latestMarketData ? "行情已更新" : "等待行情";
}

function setError(message) {
  resultsGrid.hidden = false;
  decisionPanel.className = "panel decision-panel no";
  decisionTitle.textContent = "資料或行情錯誤";
  decisionStats.innerHTML = "";
  reasonList.innerHTML = `<li>${escapeHtml(message)}</li>`;
  warningList.innerHTML = "";
  suggestionBox.hidden = true;
  tpTableBody.innerHTML = "";
  stopTableBody.innerHTML = "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function apiGetMarket() {
  const coin = getFormValue("coin");
  if (!coin) {
    setError("請先輸入幣種。");
    return null;
  }
  const market = getFormValue("market") || "futures";
  setBusy(true, "抓行情中");
  try {
    const response = await fetch(`/api/market?symbol=${encodeURIComponent(coin)}&market=${encodeURIComponent(market)}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "行情取得失敗");
    latestMarketData = data.data;
    renderQuote(latestMarketData);
    return latestMarketData;
  } catch (error) {
    setError(error.message);
    return null;
  } finally {
    setBusy(false);
  }
}

async function analyzeTrade() {
  setBusy(true, "分析中");
  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payloadFromForm())
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "分析失敗");
    latestMarketData = data.analysis.marketData;
    renderQuote(latestMarketData);
    renderAnalysis(data.analysis);
    saveHistory(data.analysis);
    renderHistory();
  } catch (error) {
    setError(error.message);
  } finally {
    setBusy(false);
  }
}

function renderQuote(data) {
  quoteEls.price.textContent = price(data.currentPrice);
  quoteEls.symbol.textContent = `${data.symbol} · ${data.market === "spot" ? "現貨" : "永續"}`;

  const change = data.priceChangePercent24h;
  quoteEls.change.textContent = change === null ? "--" : `${change}%`;
  quoteEls.change.className = change >= 0 ? "positive" : "negative";
  quoteEls.range.textContent = `${price(data.highPrice24h)} / ${price(data.lowPrice24h)}`;
  quoteEls.time.textContent = new Date(data.fetchedAt).toLocaleString("zh-TW", {
    hour12: false
  });
}

function renderAnalysis(analysis) {
  const { metrics, config } = analysis;
  resultsGrid.hidden = false;
  decisionPanel.className = `panel decision-panel ${analysis.ok ? "ok" : "no"}`;
  decisionTitle.textContent = analysis.decision;

  if (!metrics) {
    decisionStats.innerHTML = "";
    tpTableBody.innerHTML = "";
    stopTableBody.innerHTML = "";
  } else {
    decisionStats.innerHTML = [
      stat("名目金額", money(config.notionalUsdt, 0)),
      stat("最大風險", money(metrics.grossRiskUsdt)),
      stat("平均獲利 R", `${metrics.averageR}R`),
      stat("期望值", money(metrics.expectedValueUsdt)),
      stat("進場價", price(metrics.entry)),
      stat("倉位數量", qty(metrics.positionQty))
    ].join("");
    renderTpTable(metrics.tpPlan);
    renderStopTable(metrics.stopPlan);
  }

  reasonList.innerHTML = analysis.reasons.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  warningList.innerHTML = analysis.warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("");

  if (analysis.suggestion) {
    const suggestion = analysis.suggestion;
    const projected = suggestion.price
      ? `建議掛單價：${price(suggestion.price)}，估計風險 ${money(suggestion.projectedGrossRiskUsdt)}，平均 ${suggestion.projectedAverageR}R。`
      : suggestion.instruction;
    const riskBoundary = suggestion.riskBoundary
      ? `風險上限邊界價：${price(suggestion.riskBoundary)}。`
      : "";
    suggestionBox.innerHTML = `${escapeHtml(projected)} ${escapeHtml(riskBoundary)}`;
    suggestionBox.hidden = false;
  } else {
    suggestionBox.hidden = true;
  }
}

function stat(label, value) {
  return `<div class="stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderTpTable(rows) {
  tpTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${row.label}</td>
          <td>${price(row.price)}</td>
          <td>${pct(row.closePercent)}</td>
          <td>${money(row.closeNotionalUsdt)}</td>
          <td>${qty(row.closeQty)}</td>
          <td>${money(row.profitUsdt)}</td>
          <td>${row.rMultiple}R</td>
        </tr>
      `
    )
    .join("");
}

function renderStopTable(rows) {
  stopTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.trigger)}</td>
          <td>${price(row.triggerPrice)}</td>
          <td>${row.newStop === null ? "平倉完成" : price(row.newStop)}</td>
          <td>${escapeHtml(row.action)}</td>
        </tr>
      `
    )
    .join("");
}

function readHistory() {
  try {
    const items = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function writeHistory(items) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 40)));
}

function saveHistory(analysis) {
  if (!analysis.metrics) return;
  const item = {
    time: new Date().toISOString(),
    symbol: analysis.marketData.symbol,
    direction: analysis.input.direction,
    decision: analysis.decision,
    ok: analysis.ok,
    entry: analysis.metrics.entry,
    stopLoss: analysis.metrics.stopLoss,
    grossRiskUsdt: analysis.metrics.grossRiskUsdt,
    averageR: analysis.metrics.averageR,
    expectedValueUsdt: analysis.metrics.expectedValueUsdt
  };
  writeHistory([item, ...readHistory()]);
}

function renderHistory() {
  const items = readHistory();
  if (!items.length) {
    historyList.innerHTML = `<p class="muted">尚無紀錄。</p>`;
    return;
  }
  historyList.innerHTML = items
    .map(
      (item) => `
        <div class="history-item">
          <span>${new Date(item.time).toLocaleString("zh-TW", { hour12: false })}</span>
          <strong>${escapeHtml(item.symbol)} · ${item.direction === "short" ? "做空" : "做多"}</strong>
          <span class="badge ${item.ok ? "ok" : "no"}">${escapeHtml(item.decision)}</span>
          <span>${item.averageR}R</span>
          <span>${money(item.expectedValueUsdt)}</span>
        </div>
      `
    )
    .join("");
}

function exportHistory() {
  const items = readHistory();
  if (!items.length) return;
  const header = [
    "time",
    "symbol",
    "direction",
    "decision",
    "entry",
    "stopLoss",
    "grossRiskUsdt",
    "averageR",
    "expectedValueUsdt"
  ];
  const csvRows = [header.join(",")].concat(
    items.map((item) =>
      header
        .map((key) => `"${String(item[key] ?? "").replaceAll('"', '""')}"`)
        .join(",")
    )
  );
  const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "trade-decision-history.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

segmentButtons.forEach((button) => {
  button.addEventListener("click", () => {
    segmentButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    directionInput.value = button.dataset.direction;
  });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  analyzeTrade();
});

fetchMarketButton.addEventListener("click", apiGetMarket);

resetButton.addEventListener("click", () => {
  form.reset();
  directionInput.value = "long";
  segmentButtons.forEach((item) => item.classList.toggle("active", item.dataset.direction === "long"));
  resultsGrid.hidden = true;
  latestMarketData = null;
  marketStatus.textContent = "等待行情";
});

exportButton.addEventListener("click", exportHistory);

clearHistoryButton.addEventListener("click", () => {
  writeHistory([]);
  renderHistory();
});

renderHistory();
