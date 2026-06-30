# Crypto Trade Decision Desk

一個可直接推到 GitHub、部署到 Zeabur 的加密貨幣下單判斷工具。

## 功能

- 輸入幣種後自動抓 Binance 行情，預設使用 USDT 永續，抓不到時改用現貨。
- 固定以 30% 勝率、10000U 名目金額、650U 最大可接受虧損做判斷。
- 輸入進場價、止損、TP1、TP2、TP3 後，自動計算風險、平均 R、期望值與是否值得下單。
- 自動分配 TP1/TP2/TP3 平倉比例，並列出每段要平多少名目金額、數量與估計獲利。
- 自動產生移動止損規則：1R、TP1、TP2、TP3 各階段該怎麼調整。
- 本機瀏覽器會保存分析紀錄，可匯出 CSV。
- 手機與電腦都能使用，無密碼，方便快速輸入。

## 本機啟動

需要 Node.js 18 以上。

```bash
npm start
```

預設網址：

```text
http://localhost:8080
```

如果部署平台提供 `PORT`，程式會自動使用該 port；沒有提供時才使用 `8080`。

## Zeabur 部署

1. 把整個資料夾推到 GitHub。
2. 在 Zeabur 建立新服務，選擇這個 GitHub repo。
3. Zeabur 可直接使用 Dockerfile，或用 Node.js 方式執行 `npm start`。
4. 不需要資料庫、不需要設定密碼、不需要額外環境變數。

## 可選環境變數

```text
PORT=8080
BINANCE_FUTURES_BASE_URL=https://fapi.binance.com
BINANCE_SPOT_BASE_URL=https://api.binance.com
```

## 行情來源

- Binance USD-M Futures API
- Binance Spot API

這是風險管理與決策輔助工具，不保證獲利。每次下單仍需自行確認流動性、重大消息、資金費率、槓桿與交易所規則。
