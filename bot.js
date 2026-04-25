/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Multi-strategy, multi-symbol. Runs both strategies on each symbol per check.
 * Cloud mode: Railway on a cron schedule. Data from Binance (free, no auth).
 * Local mode: run manually — node bot.js
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { run as runStrategy3 } from "./strategies/strategy3/strategy3.js";

// ─── Onboarding ──────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  // If env vars are already set (e.g. Railway), skip file check
  if (missing.length === 0) {
    // All good — credentials available
  } else if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=10",
        "PAPER_TRADING=true",
        "SYMBOLS=BTCUSDT",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your BitGet credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  } else {
    console.log(`\n⚠️  Missing credentials: ${missing.join(", ")}`);
    console.log("Add them to .env or set as environment variables, then re-run.\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbols: (process.env.SYMBOLS || "BTCUSDT").split(",").map((s) => s.trim()),
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "10"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
};

const LOG_FILE = "safety-check-log.json";
const PORTFOLIO_FILE = "portfolio.json";

// ─── Portfolio Tracker ──────────────────────────────────────────────────────

function loadPortfolio() {
  const today = new Date().toISOString().slice(0, 10);
  if (!existsSync(PORTFOLIO_FILE)) {
    return {
      initialCapital: CONFIG.portfolioValue,
      totalPnL: 0,
      totalWins: 0,
      totalLosses: 0,
      todayPnL: 0,
      todayDate: today,
      closedTrades: [],
    };
  }
  const p = JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8"));
  // Reset daily stats if new day
  if (p.todayDate !== today) {
    p.todayPnL = 0;
    p.todayDate = today;
  }
  return p;
}

function savePortfolio(p) {
  writeFileSync(PORTFOLIO_FILE, JSON.stringify(p, null, 2));
}

function recordClosedTrade(portfolio, symbol, side, pnlUSD, result) {
  portfolio.totalPnL += pnlUSD;
  portfolio.todayPnL += pnlUSD;
  if (result === "WIN") portfolio.totalWins++;
  else portfolio.totalLosses++;
  portfolio.closedTrades.push({
    date: new Date().toISOString(),
    symbol, side, pnlUSD, result,
  });
  savePortfolio(portfolio);
}

function buildPortfolioBlock(portfolio) {
  const capital = portfolio.initialCapital;
  const current = capital + portfolio.totalPnL;
  const dailyTarget = capital * 0.02;
  const dailyProgress = dailyTarget > 0 ? (portfolio.todayPnL / dailyTarget * 100) : 0;
  const totalPct = (portfolio.totalPnL / capital * 100);

  let msg = `\n💰 <b>Portfolio</b>\n`;
  msg += `Initial: $${capital.toFixed(2)}\n`;
  msg += `Balance: <b>$${current.toFixed(2)}</b> (${totalPct >= 0 ? "+" : ""}${totalPct.toFixed(2)}%)\n`;
  msg += `Today P&L: ${portfolio.todayPnL >= 0 ? "+" : ""}$${portfolio.todayPnL.toFixed(2)}`;
  msg += ` / $${dailyTarget.toFixed(2)} target (${dailyProgress.toFixed(0)}%)\n`;
  msg += `Total P&L: ${portfolio.totalPnL >= 0 ? "+" : ""}$${portfolio.totalPnL.toFixed(2)}`;
  if (portfolio.totalWins + portfolio.totalLosses > 0) {
    const winRate = (portfolio.totalWins / (portfolio.totalWins + portfolio.totalLosses) * 100).toFixed(0);
    msg += ` | W:${portfolio.totalWins} L:${portfolio.totalLosses} (${winRate}% win rate)`;
  }
  return msg;
}

// ─── Telegram Notifications ─────────────────────────────────────────────────

const TELEGRAM = {
  token: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
};

async function sendTelegram(message) {
  if (!TELEGRAM.token || !TELEGRAM.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.log(`Telegram error: ${err.message}`);
  }
}

// Collect results across the full run, then send one summary
const runResults = [];

function buildTelegramSummary(openTradeUpdates, portfolio) {
  if (runResults.length === 0 && (!openTradeUpdates || openTradeUpdates.length === 0)) return null;

  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  let msg = `📊 <b>Bot Check — ${now} UTC</b>\n`;

  // ─── Open trade P&L updates ───
  if (openTradeUpdates && openTradeUpdates.length > 0) {
    msg += `\n📈 <b>Open Trades</b>\n`;
    for (const t of openTradeUpdates) {
      const arrow = t.pnlUSD >= 0 ? "🟢" : "🔴";
      const sign = t.pnlUSD >= 0 ? "+" : "";
      if (t.result === "WIN") {
        msg += `  ✅ ${t.symbol} ${t.side} — <b>WIN</b> TP hit!\n`;
        msg += `     Entry $${t.entryPrice.toFixed(2)} → $${t.currentPrice.toFixed(2)} (${sign}${t.pnlPct.toFixed(2)}%)\n`;
      } else if (t.result === "LOSS") {
        msg += `  ❌ ${t.symbol} ${t.side} — <b>LOSS</b> SL hit\n`;
        msg += `     Entry $${t.entryPrice.toFixed(2)} → $${t.currentPrice.toFixed(2)} (${sign}${t.pnlPct.toFixed(2)}%)\n`;
      } else {
        msg += `  ${arrow} ${t.symbol} ${t.side} $${t.entryPrice.toFixed(2)} → $${t.currentPrice.toFixed(2)}`;
        msg += ` (${sign}$${t.pnlUSD.toFixed(2)}, ${sign}${t.pnlPct.toFixed(2)}%)\n`;
      }
    }
  }

  // ─── New checks this run ───
  if (runResults.length > 0) {
    msg += `\n🔍 <b>New Checks</b>\n`;

    const bySymbol = {};
    for (const r of runResults) {
      if (!bySymbol[r.symbol]) bySymbol[r.symbol] = [];
      bySymbol[r.symbol].push(r);
    }

    for (const [symbol, results] of Object.entries(bySymbol)) {
      msg += `\n<b>${symbol}</b>\n`;
      for (const r of results) {
        const stratShort = r.strategy
          .replace("Strategy 1: VWAP + RSI(3) + EMA(8)", "S1 VWAP")
          .replace("Strategy 2: EMA Crossover + MACD + RSI(14)", "S2 EMA")
          .replace("Strategy 3: SMC Liquidity Sweep", "S3 SMC");

        if (r.status === "BLOCKED") {
          msg += `  ${stratShort}: ❌ ${r.reason}\n`;
        } else if (r.status === "TRADE") {
          msg += `  ${stratShort}: ✅ ${r.side} $${r.price.toFixed(2)}\n`;
          msg += `     SL $${r.sl} | TP $${r.tp1}`;
          if (r.rr) msg += ` (${r.rr}R)`;
          if (r.sizeUSD) msg += ` | Size $${r.sizeUSD.toFixed(2)}`;
          msg += `\n`;
        } else if (r.status === "SKIPPED") {
          msg += `  ${stratShort}: ⏭️ ${r.reason}\n`;
        } else if (r.status === "IDLE") {
          msg += `  ${stratShort}: ⏳ ${r.reason}\n`;
        }
      }
    }
  }

  // ─── Footer ───
  const newTrades = runResults.filter((r) => r.status === "TRADE").length;
  const skipped = runResults.filter((r) => r.status === "SKIPPED").length;
  const openCount = openTradeUpdates ? openTradeUpdates.filter((t) => t.result === "OPEN").length : 0;
  const wins = openTradeUpdates ? openTradeUpdates.filter((t) => t.result === "WIN").length : 0;
  const losses = openTradeUpdates ? openTradeUpdates.filter((t) => t.result === "LOSS").length : 0;
  const totalOpen = openCount + newTrades;

  msg += `\n─────────────────────`;
  if (wins > 0 || losses > 0) {
    msg += `\nClosed this check: ${wins} WIN, ${losses} LOSS`;
  }
  msg += `\nOpen positions: ${totalOpen} (${openCount} existing + ${newTrades} new)`;
  if (skipped > 0) msg += `\nSkipped: ${skipped} (duplicate/limit)`;
  msg += `\nMode: ${CONFIG.paperTrading ? "📋 Paper" : "🔴 Live"}`;

  // Portfolio stats
  if (portfolio) msg += buildPortfolioBlock(portfolio);

  return msg;
}

// ─── Open Trade P&L Tracker ─────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += line[i];
    }
  }
  result.push(current);
  return result;
}

async function checkOpenPaperTrades(portfolio) {
  if (!existsSync(CSV_FILE)) return [];

  const content = readFileSync(CSV_FILE, "utf8").trim();
  const lines = content.split("\n");
  if (lines.length < 2) return [];

  const openTrades = [];
  let csvModified = false;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    // 0=Date 1=Time 2=Exchange 3=Symbol 4=Strategy 5=Timeframe
    // 6=Side 7=Qty 8=Entry 9=SL 10=TP1 11=TP2 12=R:R
    // 13=Total 14=Fee 15=Net 16=OrderID 17=Mode 18=Status 19=Notes

    if (cols[18] !== "OPEN") continue;

    const symbol = cols[3];
    const side = cols[6];
    const entryPrice = parseFloat(cols[8]);
    const slDist = parseFloat(cols[9]) || entryPrice * 0.003;
    const tp1Val = cols[10] ? parseFloat(cols[10]) : null;
    const sizeUSD = parseFloat(cols[13]) || 10;

    let slPrice, tp1Price;
    if (side === "BUY") {
      slPrice = entryPrice - slDist;
      tp1Price = tp1Val || entryPrice + slDist * 2;
    } else {
      slPrice = entryPrice + slDist;
      tp1Price = tp1Val || entryPrice - slDist * 2;
    }

    try {
      const candles = await fetchCandles(symbol, "1H", 2);
      const currentPrice = candles[candles.length - 1].close;

      const pnlRaw = side === "BUY"
        ? (currentPrice - entryPrice) / entryPrice
        : (entryPrice - currentPrice) / entryPrice;
      const pnlUSD = pnlRaw * sizeUSD;
      const pnlPct = pnlRaw * 100;

      let result = "OPEN";
      if ((side === "BUY" && currentPrice <= slPrice) || (side === "SELL" && currentPrice >= slPrice)) {
        result = "LOSS";
        lines[i] = lines[i].replace(/,OPEN,"/, `,LOSS,"`);
        csvModified = true;
        recordClosedTrade(portfolio, symbol, side, pnlUSD, "LOSS");
        await sendTelegram(
          `🔴 <b>STOP LOSS HIT</b>\n\n` +
          `${symbol} ${side}\n` +
          `Entry: $${entryPrice.toFixed(2)}\n` +
          `Exit: $${currentPrice.toFixed(2)}\n` +
          `P&L: $${pnlUSD.toFixed(2)} (${pnlPct.toFixed(2)}%)` +
          buildPortfolioBlock(portfolio)
        );
      } else if ((side === "BUY" && currentPrice >= tp1Price) || (side === "SELL" && currentPrice <= tp1Price)) {
        result = "WIN";
        lines[i] = lines[i].replace(/,OPEN,"/, `,WIN,"`);
        csvModified = true;
        recordClosedTrade(portfolio, symbol, side, pnlUSD, "WIN");
        await sendTelegram(
          `🟢 <b>TAKE PROFIT HIT</b>\n\n` +
          `${symbol} ${side}\n` +
          `Entry: $${entryPrice.toFixed(2)}\n` +
          `Exit: $${currentPrice.toFixed(2)}\n` +
          `P&L: +$${pnlUSD.toFixed(2)} (+${pnlPct.toFixed(2)}%)` +
          buildPortfolioBlock(portfolio)
        );
      }

      openTrades.push({ symbol, side, entryPrice, currentPrice, slPrice, tp1Price, pnlUSD, pnlPct, result, sizeUSD });
    } catch (err) {
      // Can't fetch price — skip this trade
    }
  }

  if (csvModified) {
    writeFileSync(CSV_FILE, lines.join("\n") + "\n");
    console.log("📄 Updated closed paper trades in CSV");
  }

  return openTrades;
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1min",
    "3m": "3min",
    "5m": "5min",
    "15m": "15min",
    "30m": "30min",
    "1H": "1h",
    "4H": "4h",
    "1D": "1day",
    "1W": "1week",
  };
  const granularity = intervalMap[interval] || "1h";

  const url = `https://api.bitget.com/api/v2/spot/market/candles?symbol=${symbol}&granularity=${granularity}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BitGet API error for ${symbol}: ${res.status}`);
  const json = await res.json();

  if (json.code !== "00000") throw new Error(`BitGet API: ${json.msg || json.code}`);

  // BitGet returns: [timestamp, open, high, low, close, volume, quoteVolume]
  // Already sorted oldest first (same as Binance)
  return json.data.map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── Indicator Calculations ─────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcEMASeries(closes, period) {
  if (closes.length < period) return [];
  const multiplier = 2 / (period + 1);
  const ema = [closes.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < closes.length; i++) {
    ema.push(closes[i] * multiplier + ema[ema.length - 1] * (1 - multiplier));
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;

  const emaFast = calcEMASeries(closes, fast);
  const emaSlow = calcEMASeries(closes, slow);

  // Align: emaFast starts at index `fast-1`, emaSlow at `slow-1`
  const offset = slow - fast;
  const macdLine = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(emaFast[i + offset] - emaSlow[i]);
  }

  if (macdLine.length < signal) return null;
  const signalLine = calcEMASeries(macdLine, signal);

  const macdVal = macdLine[macdLine.length - 1];
  const signalVal = signalLine[signalLine.length - 1];

  return {
    macd: macdVal,
    signal: signalVal,
    histogram: macdVal - signalVal,
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ─── Safety Check: Strategy 1 — VWAP + RSI(3) + EMA(8) ─────────────────────

function runStrategy1Check(price, ema8, vwap, rsi3) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;
  let side = null;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");
    side = "buy";

    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");
    side = "sell";

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );
    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );
    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  return { results, allPass: results.every((r) => r.pass), side, stopLoss: null };
}

// ─── Safety Check: Strategy 2 — EMA Crossover + MACD + RSI(14) ─────────────

function runStrategy2Check(price, ema21, ema50, rsi14, macd, atr) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  const bullishTrend = ema21 > ema50;
  const bearishTrend = ema21 < ema50;
  let side = null;

  if (bullishTrend) {
    console.log(
      "  Trend: BULLISH (EMA 21 > EMA 50) — checking long conditions\n",
    );
    side = "buy";

    check(
      "EMA(21) above EMA(50) (uptrend)",
      `> ${ema50.toFixed(2)}`,
      ema21.toFixed(2),
      ema21 > ema50,
    );
    check(
      "Price above EMA(21) (riding the trend)",
      `> ${ema21.toFixed(2)}`,
      price.toFixed(2),
      price > ema21,
    );
    check(
      "RSI(14) between 40-70 (healthy momentum)",
      "40-70",
      rsi14.toFixed(2),
      rsi14 >= 40 && rsi14 <= 70,
    );
    check(
      "MACD histogram positive (momentum confirmed)",
      "> 0",
      macd.histogram.toFixed(4),
      macd.histogram > 0,
    );
  } else if (bearishTrend) {
    console.log(
      "  Trend: BEARISH (EMA 21 < EMA 50) — checking short conditions\n",
    );
    side = "sell";

    check(
      "EMA(21) below EMA(50) (downtrend)",
      `< ${ema50.toFixed(2)}`,
      ema21.toFixed(2),
      ema21 < ema50,
    );
    check(
      "Price below EMA(21) (riding the trend)",
      `< ${ema21.toFixed(2)}`,
      price.toFixed(2),
      price < ema21,
    );
    check(
      "RSI(14) between 30-60 (bearish momentum)",
      "30-60",
      rsi14.toFixed(2),
      rsi14 >= 30 && rsi14 <= 60,
    );
    check(
      "MACD histogram negative (momentum confirmed)",
      "< 0",
      macd.histogram.toFixed(4),
      macd.histogram < 0,
    );
  } else {
    console.log("  Trend: NEUTRAL — EMAs converging. No trade.\n");
    results.push({
      label: "Trend direction",
      required: "EMA 21/50 separated",
      actual: "Converging",
      pass: false,
    });
  }

  const stopLossDistance = atr ? atr * 1.5 : null;
  return {
    results,
    allPass: results.every((r) => r.pass),
    side,
    stopLoss: stopLossDistance,
  };
}

// ─── Trade Limits ───────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ───────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Tax CSV Logging ────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Strategy",
  "Timeframe",
  "Side",
  "Quantity",
  "Entry Price",
  "Stop Loss",
  "TP1",
  "TP2",
  "R:R",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Status",
  "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
    console.log(`📄 Created ${CSV_FILE}`);
  } else {
    // Upgrade headers if old format (no Strategy column)
    const firstLine = readFileSync(CSV_FILE, "utf8").split("\n")[0];
    if (!firstLine.includes("TP1") || !firstLine.includes("Status")) {
      const oldContent = readFileSync(CSV_FILE, "utf8");
      writeFileSync("trades-backup.csv", oldContent);
      writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
      console.log(
        `📄 Upgraded ${CSV_FILE} headers (old data backed up → trades-backup.csv)`,
      );
    }
  }
}

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let status = "";
  let notes = "";
  let stopLoss = "";
  let tp1 = "";
  let tp2 = "";
  let rr = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    status = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    status = "OPEN";
    notes = "All conditions met";
    stopLoss = logEntry.stopLoss
      ? logEntry.stopLoss.toFixed(2)
      : (logEntry.price * 0.003).toFixed(2);
    tp1 = logEntry.tp1 ? logEntry.tp1.toFixed(2) : "";
    tp2 = logEntry.tp2 ? logEntry.tp2.toFixed(2) : "";
    rr = logEntry.rr1 ? logEntry.rr1.toFixed(1) : "";
  } else {
    side = logEntry.side || "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    status = logEntry.error ? "ERROR" : "OPEN";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
    stopLoss = logEntry.stopLoss
      ? logEntry.stopLoss.toFixed(2)
      : (logEntry.price * 0.003).toFixed(2);
    tp1 = logEntry.tp1 ? logEntry.tp1.toFixed(2) : "";
    tp2 = logEntry.tp2 ? logEntry.tp2.toFixed(2) : "";
    rr = logEntry.rr1 ? logEntry.rr1.toFixed(1) : "";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    logEntry.strategy,
    logEntry.timeframe,
    side,
    quantity,
    logEntry.price.toFixed(2),
    stopLoss,
    tp1,
    tp2,
    rr,
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    status,
    `"${notes}"`,
  ].join(",");

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// ─── Open Position Check ───────────────────────────────────────────────────

function hasOpenPosition(symbol, strategy) {
  if (!existsSync(CSV_FILE)) return false;
  const content = readFileSync(CSV_FILE, "utf8").trim();
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    // cols[3]=Symbol, cols[4]=Strategy, cols[18]=Status
    if (cols[3] === symbol && cols[4] === strategy && cols[18] === "OPEN") return true;
  }
  return false;
}

// ─── Tax Summary ────────────────────────────────────────────────────────────

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).filter((l) => l.trim().length > 0);
  const parsed = rows.map((l) => l.split(","));

  // Column indices: 0=Date 1=Time 2=Exchange 3=Symbol 4=Strategy 5=TF
  // 6=Side 7=Qty 8=Entry 9=SL 10=TP1 11=TP2 12=RR 13=TotalUSD
  // 14=Fee 15=Net 16=OrderID 17=Mode 18=Status 19=Notes
  const live = parsed.filter((r) => r[17] === "LIVE");
  const paper = parsed.filter((r) => r[17] === "PAPER");
  const blocked = parsed.filter((r) => r[17] === "BLOCKED");

  const totalVolume = live.reduce(
    (sum, r) => sum + parseFloat(r[13] || 0),
    0,
  );
  const totalFees = live.reduce(
    (sum, r) => sum + parseFloat(r[14] || 0),
    0,
  );

  // Strategy breakdown
  const stratCounts = {};
  parsed.forEach((r) => {
    const strat = r[4] || "Unknown";
    if (!stratCounts[strat])
      stratCounts[strat] = { total: 0, passed: 0, blocked: 0 };
    stratCounts[strat].total++;
    if (r[18] === "BLOCKED") stratCounts[strat].blocked++;
    else stratCounts[strat].passed++;
  });

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${parsed.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);

  console.log(
    `\n── Strategy Breakdown ───────────────────────────────────\n`,
  );
  for (const [name, counts] of Object.entries(stratCounts)) {
    console.log(`  ${name}:`);
    console.log(
      `    Checks: ${counts.total} | Trades: ${counts.passed} | Blocked: ${counts.blocked}`,
    );
  }

  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Run Single Strategy on a Symbol ────────────────────────────────────────

async function runStrategyOnSymbol(strategy, symbol, log) {
  const stratName = strategy.name;
  const timeframe = strategy.timeframe;

  console.log(`\n━━━ ${stratName} | ${symbol} | ${timeframe} ━━━\n`);

  // Fetch candles
  console.log("── Fetching market data from BitGet ────────────────────\n");
  let candles;
  try {
    candles = await fetchCandles(symbol, timeframe, 500);
  } catch (err) {
    console.log(`⚠️  Could not fetch data for ${symbol}: ${err.message}`);
    console.log(`   Skipping — symbol may not be available on Binance.\n`);
    return null;
  }

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  let checkResult;
  let indicators = {};

  if (stratName.includes("VWAP")) {
    // Strategy 1: VWAP + RSI(3) + EMA(8)
    const ema8 = calcEMA(closes, 8);
    const vwap = calcVWAP(candles);
    const rsi3 = calcRSI(closes, 3);

    indicators = { ema8, vwap, rsi3 };
    console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
    console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
    console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

    if (!vwap || !rsi3) {
      console.log("\n⚠️  Not enough data for indicators. Skipping.");
      return null;
    }

    console.log(
      "\n── Safety Check ─────────────────────────────────────────\n",
    );
    checkResult = runStrategy1Check(price, ema8, vwap, rsi3);
  } else if (stratName.includes("EMA Crossover")) {
    // Strategy 2: EMA Crossover + MACD + RSI(14)
    const ema21 = calcEMA(closes, 21);
    const ema50 = calcEMA(closes, 50);
    const rsi14 = calcRSI(closes, 14);
    const macd = calcMACD(closes);
    const atr = calcATR(candles);

    indicators = { ema21, ema50, rsi14, macd, atr };
    console.log(`  EMA(21): $${ema21.toFixed(2)}`);
    console.log(`  EMA(50): $${ema50.toFixed(2)}`);
    console.log(`  RSI(14): ${rsi14 ? rsi14.toFixed(2) : "N/A"}`);
    console.log(
      `  MACD:    ${macd ? macd.histogram.toFixed(4) : "N/A"} (histogram)`,
    );
    console.log(`  ATR(14): ${atr ? `$${atr.toFixed(2)}` : "N/A"}`);

    if (!rsi14 || !macd) {
      console.log("\n⚠️  Not enough data for indicators. Skipping.");
      return null;
    }

    console.log(
      "\n── Safety Check ─────────────────────────────────────────\n",
    );
    checkResult = runStrategy2Check(price, ema21, ema50, rsi14, macd, atr);
  } else {
    console.log(`⚠️  Unknown strategy: ${stratName}. Skipping.`);
    return null;
  }

  const { results, allPass, side, stopLoss } = checkResult;
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe,
    strategy: stratName,
    price,
    indicators,
    conditions: results,
    allPass,
    side: side ? side.toUpperCase() : null,
    tradeSize,
    stopLoss: stopLoss || null,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));

    // Track for Telegram
    runResults.push({
      symbol, strategy: stratName, status: "BLOCKED",
      reason: failed[0], price,
    });
  } else {
    // Check daily trade limit
    if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
      console.log(`⏭️  ALL CONDITIONS MET — but daily trade limit reached (${CONFIG.maxTradesPerDay}). Skipping entry.`);
      runResults.push({
        symbol, strategy: stratName, status: "SKIPPED",
        reason: "Daily limit reached", price,
      });
      log.trades.push(logEntry);
      writeTradeCsv(logEntry);
      return logEntry;
    }

    // Check if we already have an open position on this symbol from this strategy
    if (hasOpenPosition(symbol, stratName)) {
      console.log(`⏭️  ALL CONDITIONS MET — but ${symbol} already has an open ${stratName} position. Skipping.`);
      runResults.push({
        symbol, strategy: stratName, status: "SKIPPED",
        reason: "Open position exists", price,
      });
      log.trades.push(logEntry);
      writeTradeCsv(logEntry);
      return logEntry;
    }

    console.log(`✅ ALL CONDITIONS MET`);

    // Calculate TP targets for S1/S2 (S3 sets its own)
    const slDist = stopLoss || price * 0.003;
    if (!logEntry.tp1) {
      if (side === "BUY" || side === "buy") {
        logEntry.slPrice = price - slDist;
        logEntry.tp1 = price + slDist * 2;
        logEntry.tp2 = price + slDist * 3;
      } else {
        logEntry.slPrice = price + slDist;
        logEntry.tp1 = price - slDist * 2;
        logEntry.tp2 = price - slDist * 3;
      }
      logEntry.rr1 = 2;
    }

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side} ${symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(
        `   Entry: $${price.toFixed(2)} | SL: $${(logEntry.slPrice || price - slDist).toFixed(2)} | TP1: $${logEntry.tp1.toFixed(2)} (2R)`,
      );
      console.log(
        `   (Set PAPER_TRADING=false in .env to place real orders)`,
      );
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`,
      );
      try {
        const order = await placeBitGetOrder(symbol, side, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

    // Track for Telegram
    runResults.push({
      symbol, strategy: stratName, status: "TRADE",
      side: side.toUpperCase(), price,
      sl: (logEntry.slPrice || price - slDist).toFixed(2),
      tp1: logEntry.tp1 ? logEntry.tp1.toFixed(2) : null,
      rr: logEntry.rr1 || 2,
      sizeUSD: tradeSize,
    });

    // Instant trade alert
    const stratShort = stratName
      .replace("Strategy 1: VWAP + RSI(3) + EMA(8)", "S1 VWAP")
      .replace("Strategy 2: EMA Crossover + MACD + RSI(14)", "S2 EMA");
    const slPriceStr = (logEntry.slPrice || price - slDist).toFixed(2);
    await sendTelegram(
      `🚨 <b>TRADE ALERT</b>\n\n` +
      `${CONFIG.paperTrading ? "📋 Paper" : "🔴 Live"} | ${stratShort}\n` +
      `<b>${side.toUpperCase()} ${symbol}</b>\n\n` +
      `Entry: $${price.toFixed(2)}\n` +
      `SL: $${slPriceStr}\n` +
      `TP1: $${logEntry.tp1.toFixed(2)} (${logEntry.rr1 || 2}R)\n` +
      `Size: $${tradeSize.toFixed(2)}`
    );
  }

  // Save to log and CSV
  log.trades.push(logEntry);
  writeTradeCsv(logEntry);

  return logEntry;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Multi-Strategy");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log(`  Symbols: ${CONFIG.symbols.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy rules
  const rules = JSON.parse(readFileSync("rules.json", "utf8"));

  rules.strategies.forEach((s) => {
    console.log(`\n  📊 ${s.name} (${s.timeframe})`);
  });

  // Load portfolio tracker
  const portfolio = loadPortfolio();

  // Check open paper trades for P&L updates
  console.log("\n── Checking open paper trades ──────────────────────────\n");
  const openTradeUpdates = await checkOpenPaperTrades(portfolio);
  if (openTradeUpdates.length > 0) {
    for (const t of openTradeUpdates) {
      const sign = t.pnlUSD >= 0 ? "+" : "";
      const icon = t.result === "WIN" ? "✅" : t.result === "LOSS" ? "❌" : t.pnlUSD >= 0 ? "🟢" : "🔴";
      console.log(`  ${icon} ${t.symbol} ${t.side} $${t.entryPrice.toFixed(2)} → $${t.currentPrice.toFixed(2)} (${sign}${t.pnlPct.toFixed(2)}%) ${t.result}`);
    }
  } else {
    console.log("  No open trades");
  }

  // Load log and check daily limits
  const log = loadLog();
  const tradeLimitReached = !checkTradeLimits(log);
  if (tradeLimitReached) {
    console.log("\n⚠️  Daily trade limit reached — analysis will still run but no new entries.");
  }

  // Run each strategy on each symbol
  for (const strategy of rules.strategies) {
    for (const symbol of CONFIG.symbols) {
      const result = await runStrategyOnSymbol(strategy, symbol, log);
      if (result === null) {
        runResults.push({
          symbol, strategy: strategy.name, status: "IDLE",
          reason: "Not enough data", price: null,
        });
      }
    }
  }

  // ─── Run Strategy 3 (SMC Liquidity Sweep) on each symbol ────────
  for (const symbol of CONFIG.symbols) {

    console.log(`\n━━━ Strategy 3: SMC Liquidity Sweep | ${symbol} ━━━`);

    try {
      const s3Result = await runStrategy3(
        symbol,
        fetchCandles,
        log,
        CONFIG.portfolioValue,
        CONFIG.maxTradeSizeUSD,
      );

      if (s3Result && s3Result.decision === "ENTER" && s3Result.trade) {
        // Check daily trade limit
        if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
          console.log(`  ⏭️  S3 entry signal — but daily trade limit reached. Skipping entry.`);
          runResults.push({
            symbol, strategy: "Strategy 3: SMC Liquidity Sweep", status: "SKIPPED",
            reason: "Daily limit reached", price: s3Result.trade.entryPrice,
          });
          continue;
        }

        // Check if we already have an open position on this symbol from S3
        if (hasOpenPosition(symbol, "Strategy 3: SMC Liquidity Sweep")) {
          console.log(`  ⏭️  S3 entry signal — but ${symbol} already has an open S3 position. Skipping.`);
          runResults.push({
            symbol, strategy: "Strategy 3: SMC Liquidity Sweep", status: "SKIPPED",
            reason: "Open position exists", price: s3Result.trade.entryPrice,
          });
          continue;
        }

        const t = s3Result.trade;
        const tradeSize = t.sizeUSD;
        const price = t.entryPrice;

        const logEntry = {
          timestamp: new Date().toISOString(),
          symbol,
          timeframe: "1H/5m",
          strategy: "Strategy 3: SMC Liquidity Sweep",
          price,
          indicators: { htfTrend: s3Result.htf?.trend, ltfTrend: s3Result.ltf?.trend },
          conditions: s3Result.auditTrail.map((a) => ({ label: a.msg, pass: true })),
          allPass: true,
          side: t.side.toUpperCase(),
          tradeSize,
          stopLoss: Math.abs(t.entryPrice - t.slPrice),
          tp1: t.tp1,
          tp2: t.tp2,
          rr1: t.rr1,
          orderPlaced: false,
          orderId: null,
          paperTrading: CONFIG.paperTrading,
          limits: {
            maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
            maxTradesPerDay: CONFIG.maxTradesPerDay,
            tradesToday: countTodaysTrades(log),
          },
        };

        if (CONFIG.paperTrading) {
          console.log(
            `\n📋 PAPER TRADE — would ${t.side} ${symbol} ~$${tradeSize.toFixed(2)}`,
          );
          console.log(`   SL: $${t.slPrice.toFixed(2)} | TP1: $${t.tp1.toFixed(2)} (${t.rr1.toFixed(1)}R)`);
          logEntry.orderPlaced = true;
          logEntry.orderId = `PAPER-${Date.now()}`;
        } else {
          console.log(
            `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${t.side.toUpperCase()} ${symbol}`,
          );
          try {
            const order = await placeBitGetOrder(symbol, t.side, tradeSize, price);
            logEntry.orderPlaced = true;
            logEntry.orderId = order.orderId;
            console.log(`✅ ORDER PLACED — ${order.orderId}`);
          } catch (err) {
            console.log(`❌ ORDER FAILED — ${err.message}`);
            logEntry.error = err.message;
          }
        }

        // Track for Telegram
        runResults.push({
          symbol, strategy: "Strategy 3: SMC Liquidity Sweep", status: "TRADE",
          side: t.side.toUpperCase(), price,
          sl: t.slPrice ? t.slPrice.toFixed(2) : null,
          tp1: t.tp1 ? t.tp1.toFixed(2) : null,
          rr: t.rr1 || null,
          sizeUSD: tradeSize,
        });

        // Instant trade alert
        await sendTelegram(
          `🚨 <b>TRADE ALERT</b>\n\n` +
          `${CONFIG.paperTrading ? "📋 Paper" : "🔴 Live"} | S3 SMC\n` +
          `<b>${t.side.toUpperCase()} ${symbol}</b>\n\n` +
          `Entry: $${price.toFixed(2)}\n` +
          `SL: $${t.slPrice.toFixed(2)}\n` +
          `TP1: $${t.tp1.toFixed(2)} (${t.rr1.toFixed(1)}R)\n` +
          `TP2: $${t.tp2.toFixed(2)} (${t.rr2.toFixed(1)}R)\n` +
          `Size: $${tradeSize.toFixed(2)}\n` +
          `Sweep: ${t.entryZone || "N/A"}`
        );

        log.trades.push(logEntry);
        writeTradeCsv(logEntry);
      } else {
        // No setup or blocked
        const reason = s3Result?.decision === "BLOCKED"
          ? s3Result.auditTrail?.slice(-1)[0]?.msg || "Blocked by filter"
          : s3Result?.auditTrail?.slice(-1)[0]?.msg || "No actionable setup";
        const status = s3Result?.decision === "BLOCKED" ? "BLOCKED" : "IDLE";

        runResults.push({
          symbol, strategy: "Strategy 3: SMC Liquidity Sweep", status,
          reason,
          price: s3Result?.htf?.price || null,
        });
      }
    } catch (err) {
      console.log(`  ❌ Strategy 3 error on ${symbol}: ${err.message}`);
      runResults.push({
        symbol, strategy: "Strategy 3: SMC Liquidity Sweep", status: "IDLE",
        reason: `Error: ${err.message}`, price: null,
      });
    }
  }

  // ─── Send Telegram summary ─────────────────────────────────────
  const summary = buildTelegramSummary(openTradeUpdates, portfolio);
  if (summary) await sendTelegram(summary);

  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log(
    "═══════════════════════════════════════════════════════════\n",
  );
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
