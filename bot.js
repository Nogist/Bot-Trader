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
import { findDynamicTargets } from "./lib/keyLevels.js";
import { analyzeStructure } from "./strategies/strategy3/structureDetector.js";

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
  // No max trade count — circuit breakers + duplicate prevention handle risk
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

    // Profit factor — total winning $ / total losing $
    const winningSum = (portfolio.closedTrades || [])
      .filter(t => t.pnlUSD > 0)
      .reduce((sum, t) => sum + t.pnlUSD, 0);
    const losingSum = Math.abs((portfolio.closedTrades || [])
      .filter(t => t.pnlUSD < 0)
      .reduce((sum, t) => sum + t.pnlUSD, 0));
    if (losingSum > 0) {
      msg += ` | PF: ${(winningSum / losingSum).toFixed(2)}`;
    }
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
  const now = new Date().toISOString().slice(0, 16).replace("T", " ");
  let msg = `📊 <b>Bot Check — ${now} UTC</b>\n`;

  // Always send a status — even when nothing happened
  if (runResults.length === 0 && (!openTradeUpdates || openTradeUpdates.length === 0)) {
    msg += `\n⏳ All quiet — no setups found, no open positions.`;
    msg += `\nMode: ${CONFIG.paperTrading ? "📋 Paper" : "🔴 Live"}`;
    if (portfolio) msg += buildPortfolioBlock(portfolio);
    return msg;
  }

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

// ─── Dynamic Exit Engine ──────────────────────────────────────────────────

function shouldExitEarly(candles, side, entryPrice, strategy, tp1Price, hoursOpen) {
  if (!candles || candles.length < 30) return { shouldExit: false };

  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const pnlRaw = side === "BUY"
    ? (price - entryPrice) / entryPrice
    : (entryPrice - price) / entryPrice;

  // How far back to check for structure breaks — covers sleep gaps
  // If bot was asleep 11 hours, check last 12 candles (not just 5)
  const chochLookback = Math.max(5, Math.min(Math.ceil(hoursOpen || 5), 24));

  // 1. Structure break — CHoCH against position (always triggers exit)
  try {
    const structure = analyzeStructure(candles, 3);
    const minIndex = candles.length - chochLookback;
    const recentCHoCH = structure.events.filter(
      (e) => e.type === "CHoCH" && e.index >= minIndex,
    );

    // Count CHoCH events against us — single might be noise, multiple = confirmed reversal
    let chochAgainst = 0;
    let lastChochReason = "";
    for (const event of recentCHoCH) {
      if (side === "BUY" && event.direction === "bearish") {
        chochAgainst++;
        lastChochReason = "Bearish CHoCH — structure broke against long";
      }
      if (side === "SELL" && event.direction === "bullish") {
        chochAgainst++;
        lastChochReason = "Bullish CHoCH — structure broke against short";
      }
    }

    // Also check: did the structure RECOVER after the break?
    // If latest trend matches our side, the break may have been a fakeout
    const currentTrend = structure.currentTrend;
    const trendMatchesSide =
      (side === "BUY" && currentTrend === "bullish") ||
      (side === "SELL" && currentTrend === "bearish");

    if (chochAgainst > 0) {
      if (chochAgainst >= 2) {
        // Multiple CHoCH against us — confirmed reversal, exit regardless
        return { shouldExit: true, reason: `${lastChochReason} (${chochAgainst}x confirmed)` };
      }
      if (!trendMatchesSide) {
        // Single CHoCH + current trend still against us — exit
        return { shouldExit: true, reason: lastChochReason };
      }
      // Single CHoCH but trend recovered — fakeout, stay in trade
      console.log(`  ℹ️  CHoCH detected but trend recovered to ${currentTrend} — holding position`);
    }
  } catch {
    // Structure analysis failed — skip this check
  }

  // 2. Momentum fade — only when trade is losing (cut losers before SL)
  if (pnlRaw < 0) {
    if (strategy.includes("EMA Crossover")) {
      const ema21 = calcEMA(closes, 21);
      const macd = calcMACD(closes);
      if (side === "BUY" && price < ema21 && macd && macd.histogram < 0) {
        return { shouldExit: true, reason: "Below EMA(21) + MACD negative — momentum reversed" };
      }
      if (side === "SELL" && price > ema21 && macd && macd.histogram > 0) {
        return { shouldExit: true, reason: "Above EMA(21) + MACD positive — momentum reversed" };
      }
    }
    if (strategy.includes("VWAP")) {
      const rsi3 = calcRSI(closes, 3);
      const vwap = calcVWAP(candles);
      if (side === "BUY" && rsi3 && rsi3 > 65 && vwap && price < vwap) {
        return { shouldExit: true, reason: "RSI(3) above 65 + below VWAP — snap-back exhausted" };
      }
      if (side === "SELL" && rsi3 && rsi3 < 35 && vwap && price > vwap) {
        return { shouldExit: true, reason: "RSI(3) below 35 + above VWAP — reversal exhausted" };
      }
    }
  }

  // 3. Key level rejection near TP — take profit instead of hoping for breakout
  if (tp1Price) {
    const totalTPDist = Math.abs(tp1Price - entryPrice);
    const distToTP = Math.abs(tp1Price - price);
    const tpProgress = totalTPDist > 0 ? 1 - distToTP / totalTPDist : 0;

    if (tpProgress > 0.8) { // price within 20% of TP
      const last = candles[candles.length - 1];
      const body = Math.abs(last.close - last.open) || 0.01;
      const upperWick = last.high - Math.max(last.close, last.open);
      const lowerWick = Math.min(last.close, last.open) - last.low;

      if (side === "BUY" && upperWick > body * 2) {
        return { shouldExit: true, reason: `Rejection near TP — taking ${(tpProgress * 100).toFixed(0)}% profit` };
      }
      if (side === "SELL" && lowerWick > body * 2) {
        return { shouldExit: true, reason: `Rejection near TP — taking ${(tpProgress * 100).toFixed(0)}% profit` };
      }
    }
  }

  return { shouldExit: false };
}

async function checkOpenPaperTrades(portfolio) {
  if (!existsSync(CSV_FILE)) return [];

  const content = readFileSync(CSV_FILE, "utf8").trim();
  const lines = content.split("\n");
  if (lines.length < 2) return [];

  // Gather open trades per symbol so we fetch candles once per symbol
  const symbolTrades = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols[18] !== "OPEN") continue;
    const symbol = cols[3];
    if (!symbolTrades[symbol]) symbolTrades[symbol] = [];
    symbolTrades[symbol].push({ lineIndex: i, cols });
  }

  // Fetch candles once per symbol — enough to cover the oldest open trade
  const candleCache = {};
  for (const [symbol, trades] of Object.entries(symbolTrades)) {
    let maxCandles = 10;
    for (const t of trades) {
      const tradeOpenTime = new Date(`${t.cols[0]}T${t.cols[1]}Z`).getTime();
      const hoursSinceOpen = Math.ceil((Date.now() - tradeOpenTime) / (1000 * 60 * 60));
      maxCandles = Math.max(maxCandles, hoursSinceOpen + 2);
    }
    maxCandles = Math.min(maxCandles, 500);
    try {
      candleCache[symbol] = await fetchCandles(symbol, "1H", maxCandles);
    } catch (err) {
      console.log(`  ⚠️ Could not fetch candles for ${symbol}: ${err.message}`);
    }
  }

  const openTrades = [];
  let csvModified = false;

  for (const [symbol, trades] of Object.entries(symbolTrades)) {
    const candles = candleCache[symbol];
    if (!candles || candles.length === 0) continue;

    const currentPrice = candles[candles.length - 1].close;

    for (const { lineIndex, cols } of trades) {
      // 0=Date 1=Time 2=Exchange 3=Symbol 4=Strategy 5=Timeframe
      // 6=Side 7=Qty 8=Entry 9=SL 10=TP1 11=TP2 12=R:R
      // 13=Total 14=Fee 15=Net 16=OrderID 17=Mode 18=Status 19=Notes
      const side = cols[6];
      const entryPrice = parseFloat(cols[8]);
      const slDist = parseFloat(cols[9]) || entryPrice * 0.003;
      const tp1Val = cols[10] ? parseFloat(cols[10]) : null;
      const sizeUSD = parseFloat(cols[13]) || 10;
      const tradeOpenTime = new Date(`${cols[0]}T${cols[1]}Z`).getTime();

      const notes = cols[19] || "";
      let slPrice, tp1Price;
      if (side === "BUY") {
        slPrice = entryPrice - slDist;
        tp1Price = tp1Val || entryPrice + slDist * 2;
      } else {
        slPrice = entryPrice + slDist;
        tp1Price = tp1Val || entryPrice - slDist * 2;
      }

      // Break-even: check if already triggered in a previous run
      let breakEvenTriggered = notes.includes("BE:active");
      const oneRLevel = side === "BUY" ? entryPrice + slDist : entryPrice - slDist;
      if (breakEvenTriggered) slPrice = entryPrice; // SL already at entry

      // Walk candles since trade opened — check if high/low ever hit TP or SL
      let result = "OPEN";
      let exitPrice = currentPrice;

      for (const candle of candles) {
        if (candle.time < tradeOpenTime) continue;

        // Check if price reached 1R profit → trigger break-even
        if (!breakEvenTriggered) {
          const reachedOneR = side === "BUY"
            ? candle.high >= oneRLevel
            : candle.low <= oneRLevel;
          if (reachedOneR) {
            breakEvenTriggered = true;
            slPrice = entryPrice; // move SL to entry
          }
        }

        if (side === "BUY") {
          const tpHit = candle.high >= tp1Price;
          const slHit = candle.low <= slPrice;

          if (tpHit && slHit) {
            // Both levels touched in same candle — closer to open was hit first
            const distToTP = Math.abs(candle.open - tp1Price);
            const distToSL = Math.abs(candle.open - slPrice);
            result = distToTP < distToSL ? "WIN" : "LOSS";
            exitPrice = result === "WIN" ? tp1Price : slPrice;
            break;
          } else if (tpHit) {
            result = "WIN";
            exitPrice = tp1Price;
            break;
          } else if (slHit) {
            result = "LOSS";
            exitPrice = slPrice;
            break;
          }
        } else {
          // SELL
          const tpHit = candle.low <= tp1Price;
          const slHit = candle.high >= slPrice;

          if (tpHit && slHit) {
            const distToTP = Math.abs(candle.open - tp1Price);
            const distToSL = Math.abs(candle.open - slPrice);
            result = distToTP < distToSL ? "WIN" : "LOSS";
            exitPrice = result === "WIN" ? tp1Price : slPrice;
            break;
          } else if (tpHit) {
            result = "WIN";
            exitPrice = tp1Price;
            break;
          } else if (slHit) {
            result = "LOSS";
            exitPrice = slPrice;
            break;
          }
        }
      }

      // Persist break-even state to CSV if newly triggered and trade still open
      if (breakEvenTriggered && !notes.includes("BE:active") && result === "OPEN") {
        // Only update notes — keep original SL distance intact for R:R tracking
        const csvCols = parseCSVLine(lines[lineIndex]);
        csvCols[19] = `"${(notes || "All conditions met").replace(/"/g, "")} | BE:active"`;
        lines[lineIndex] = csvCols.join(",");
        csvModified = true;
        await sendTelegram(
          `🔒 <b>BREAK-EVEN</b>\n\n` +
          `${symbol} ${side} — SL moved to entry\n` +
          `Entry: $${entryPrice.toFixed(2)} | 1R reached at $${oneRLevel.toFixed(2)}\n` +
          `Now a free trade — worst case $0`
        );
      }

      // Dynamic exit — check if chart says "get out" even before TP/SL
      if (result === "OPEN") {
        const hoursOpen = (Date.now() - tradeOpenTime) / (1000 * 60 * 60);
        if (hoursOpen >= 3) {
          const strategy = cols[4];
          const exitCheck = shouldExitEarly(candles, side, entryPrice, strategy, tp1Price, hoursOpen);
          if (exitCheck.shouldExit) {
            exitPrice = currentPrice;
            const earlyPnlRaw = side === "BUY"
              ? (exitPrice - entryPrice) / entryPrice
              : (entryPrice - exitPrice) / entryPrice;
            result = earlyPnlRaw >= 0 ? "WIN" : "LOSS";

            // Update CSV status and notes
            const csvCols2 = parseCSVLine(lines[lineIndex]);
            csvCols2[18] = result;
            csvCols2[19] = `"Early exit: ${exitCheck.reason}"`;
            lines[lineIndex] = csvCols2.join(",");
            csvModified = true;

            const earlyFees = sizeUSD * 0.001 * 2;
            const earlyPnlAfterFees = earlyPnlRaw * sizeUSD - earlyFees;
            recordClosedTrade(portfolio, symbol, side, earlyPnlAfterFees, result);
            await sendTelegram(
              `⚡ <b>EARLY EXIT</b>\n\n` +
              `${symbol} ${side} — ${exitCheck.reason}\n` +
              `Entry: $${entryPrice.toFixed(2)}\n` +
              `Exit: $${exitPrice.toFixed(2)}\n` +
              `P&L: ${earlyPnlAfterFees >= 0 ? "+" : ""}$${earlyPnlAfterFees.toFixed(2)} (${(earlyPnlRaw * 100).toFixed(2)}%) [fees: -$${earlyFees.toFixed(2)}]` +
              buildPortfolioBlock(portfolio)
            );
          }
        }
      }

      // Calculate P&L based on exit (TP/SL/early) or current price (still open)
      const pnlPrice = result === "OPEN" ? currentPrice : exitPrice;
      const pnlRaw = side === "BUY"
        ? (pnlPrice - entryPrice) / entryPrice
        : (entryPrice - pnlPrice) / entryPrice;
      const pnlUSD = pnlRaw * sizeUSD;
      const pnlPct = pnlRaw * 100;

      if (result === "LOSS" || result === "WIN") {
        // Safe CSV update — parse columns properly instead of regex
        const csvCols3 = parseCSVLine(lines[lineIndex]);
        csvCols3[18] = result;
        lines[lineIndex] = csvCols3.join(",");
        csvModified = true;

        // Deduct fees from P&L (0.1% entry + 0.1% exit)
        const tradeFees = sizeUSD * 0.001 * 2;
        const pnlAfterFees = pnlUSD - tradeFees;
        recordClosedTrade(portfolio, symbol, side, pnlAfterFees, result);

        if (result === "LOSS") {
          await sendTelegram(
            `🔴 <b>STOP LOSS HIT</b>\n\n` +
            `${symbol} ${side}\n` +
            `Entry: $${entryPrice.toFixed(2)}\n` +
            `Exit: $${exitPrice.toFixed(2)}\n` +
            `P&L: $${pnlAfterFees.toFixed(2)} (${pnlPct.toFixed(2)}%) [fees: -$${tradeFees.toFixed(2)}]` +
            buildPortfolioBlock(portfolio)
          );
        } else {
          await sendTelegram(
            `🟢 <b>TAKE PROFIT HIT</b>\n\n` +
            `${symbol} ${side}\n` +
            `Entry: $${entryPrice.toFixed(2)}\n` +
            `Exit: $${exitPrice.toFixed(2)}\n` +
            `P&L: +$${pnlAfterFees.toFixed(2)} (+${pnlPct.toFixed(2)}%) [fees: -$${tradeFees.toFixed(2)}]` +
            buildPortfolioBlock(portfolio)
          );
        }
      }

      openTrades.push({
        symbol, side, entryPrice,
        currentPrice: result === "OPEN" ? currentPrice : exitPrice,
        slPrice, tp1Price, pnlUSD, pnlPct, result, sizeUSD,
      });
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
      "RSI(14) between 15-50 (bearish momentum)",
      "15-50",
      rsi14.toFixed(2),
      rsi14 >= 15 && rsi14 <= 50,
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

function checkTradeLimits(log, portfolio) {
  const todayCount = countTodaysTrades(log);
  const capital = portfolio ? portfolio.initialCapital : CONFIG.portfolioValue;

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  console.log(
    `✅ Trades today: ${todayCount} (no max — duplicates blocked per symbol/strategy)`,
  );

  // Daily loss circuit breaker: 20% of capital
  if (portfolio) {
    const dailyLossLimit = capital * -0.20;
    if (portfolio.todayPnL <= dailyLossLimit) {
      console.log(
        `🛑 Daily loss circuit breaker: $${portfolio.todayPnL.toFixed(2)} exceeds -20% ($${dailyLossLimit.toFixed(2)})`,
      );
      console.log(`   No new entries — open positions still monitored.`);
      checkTradeLimits._lastReason = `Daily loss circuit breaker: $${portfolio.todayPnL.toFixed(2)} lost today (>${Math.abs(dailyLossLimit).toFixed(0)}% of capital). Review your strategy. Resumes tomorrow.`;
      return false;
    }
    console.log(
      `✅ Today P&L: $${portfolio.todayPnL.toFixed(2)} — within daily loss limit ($${dailyLossLimit.toFixed(2)})`,
    );

    // Weekly loss circuit breaker: 40% of capital over 7 days
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weeklyPnL = (portfolio.closedTrades || [])
      .filter((t) => new Date(t.date) >= oneWeekAgo)
      .reduce((sum, t) => sum + t.pnlUSD, 0);
    const weeklyLossLimit = capital * -0.40;
    if (weeklyPnL <= weeklyLossLimit) {
      console.log(
        `🛑 Weekly loss circuit breaker: $${weeklyPnL.toFixed(2)} exceeds -40% ($${weeklyLossLimit.toFixed(2)})`,
      );
      console.log(`   No new entries — open positions still monitored.`);
      checkTradeLimits._lastReason = `Weekly loss circuit breaker: $${weeklyPnL.toFixed(2)} lost this week (>${Math.abs(weeklyLossLimit).toFixed(0)}% of capital). Serious review needed. Resumes as losses roll off the 7-day window.`;
      return false;
    }
    console.log(
      `✅ Week P&L: $${weeklyPnL.toFixed(2)} — within weekly loss limit ($${weeklyLossLimit.toFixed(2)})`,
    );
  }

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

    // One-time cleanup: mark ghost positions (OPEN but no order ID) as SKIPPED
    const content = readFileSync(CSV_FILE, "utf8");
    const lines = content.split("\n");
    let cleaned = 0;
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      const cols = parseCSVLine(lines[i]);
      // cols[16]=OrderID, cols[18]=Status
      if (cols[18] === "OPEN" && (!cols[16] || cols[16].trim() === "")) {
        lines[i] = lines[i].replace(/,OPEN,"/, `,SKIPPED,"`);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      writeFileSync(CSV_FILE, lines.join("\n"));
      console.log(`🧹 Cleaned ${cleaned} ghost positions (OPEN with no order ID → SKIPPED)`);
    }
  }
}

function resetPortfolioIfCorrupted() {
  if (!existsSync(PORTFOLIO_FILE)) return;
  const p = JSON.parse(readFileSync(PORTFOLIO_FILE, "utf8"));
  // If portfolio has losses but 0 wins, and total trades > 10, likely corrupted by ghosts
  if (p.totalWins === 0 && p.totalLosses > 10 && p.closedTrades.length > 10) {
    console.log(`🧹 Portfolio stats look corrupted by ghost trades — resetting counters`);
    p.totalPnL = 0;
    p.totalWins = 0;
    p.totalLosses = 0;
    p.todayPnL = 0;
    p.closedTrades = [];
    savePortfolio(p);
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
  } else if (logEntry.allPass && !logEntry.orderPlaced) {
    // Conditions met but trade not placed (daily limit, duplicate, circuit breaker)
    side = logEntry.side || "";
    mode = logEntry.paperTrading ? "PAPER" : "LIVE";
    status = "SKIPPED";
    notes = "Conditions met — skipped (limit/duplicate)";
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
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f.label}`));

    // Build clear reason: "RSI(3): needed > 70, got 45.2"
    const failReasons = failed.map((f) => {
      const shortLabel = f.label.split("(")[0].trim();
      return `${shortLabel}: need ${f.required}, got ${f.actual}`;
    });

    // Track for Telegram — show all failed conditions
    runResults.push({
      symbol, strategy: stratName, status: "BLOCKED",
      reason: failReasons.join("; "), price,
    });
  } else {
    // No max trade count — duplicate prevention per symbol/strategy handles spam

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

    // Dynamic R:R — use key levels from chart structure
    const targets = findDynamicTargets(candles, price, side);
    if (targets.skipTrade) {
      console.log(`⏭️  R:R too low (${targets.rr1.toFixed(1)}:1) — risking more than potential reward. Need 1.5:1 min. Skipping.`);
      runResults.push({
        symbol, strategy: stratName, status: "SKIPPED",
        reason: `R:R ${targets.rr1.toFixed(1)}:1 — would risk $1 to make $${targets.rr1.toFixed(2)} (need 1.5:1 min)`, price,
      });
      log.trades.push(logEntry);
      writeTradeCsv(logEntry);
      return logEntry;
    }

    logEntry.slPrice = targets.sl;
    logEntry.stopLoss = targets.slDist;
    logEntry.tp1 = targets.tp1;
    logEntry.tp2 = targets.tp2;
    logEntry.rr1 = targets.rr1;

    console.log(`   Key levels → SL: $${targets.sl.toFixed(2)} | TP1: $${targets.tp1.toFixed(2)} (${targets.rr1.toFixed(1)}R) | TP2: $${targets.tp2.toFixed(2)} (${targets.rr2.toFixed(1)}R)`);
    if (targets.levels.support.length > 0) {
      console.log(`   Support: ${targets.levels.support.map((l) => `$${l.price.toFixed(2)} (${l.type})`).join(", ")}`);
    }
    if (targets.levels.resistance.length > 0) {
      console.log(`   Resistance: ${targets.levels.resistance.map((l) => `$${l.price.toFixed(2)} (${l.type})`).join(", ")}`);
    }

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side} ${symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(
        `   Entry: $${price.toFixed(2)} | SL: $${targets.sl.toFixed(2)} | TP1: $${targets.tp1.toFixed(2)} (${targets.rr1.toFixed(1)}R)`,
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
      sl: logEntry.slPrice.toFixed(2),
      tp1: logEntry.tp1.toFixed(2),
      rr: logEntry.rr1,
      sizeUSD: tradeSize,
    });

    // Instant trade alert
    const stratShort = stratName
      .replace("Strategy 1: VWAP + RSI(3) + EMA(8)", "S1 VWAP")
      .replace("Strategy 2: EMA Crossover + MACD + RSI(14)", "S2 EMA");
    await sendTelegram(
      `🚨 <b>TRADE ALERT</b>\n\n` +
      `${CONFIG.paperTrading ? "📋 Paper" : "🔴 Live"} | ${stratShort}\n` +
      `<b>${side.toUpperCase()} ${symbol}</b>\n\n` +
      `Entry: $${price.toFixed(2)}\n` +
      `SL: $${logEntry.slPrice.toFixed(2)}\n` +
      `TP1: $${logEntry.tp1.toFixed(2)} (${logEntry.rr1.toFixed(1)}R)\n` +
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
  resetPortfolioIfCorrupted();

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

  // Load log and check circuit breakers (no max trade count — duplicates blocked per symbol/strategy)
  const log = loadLog();
  const circuitBreakerTripped = !checkTradeLimits(log, portfolio);
  if (circuitBreakerTripped) {
    console.log("\n⚠️  Circuit breaker active — skipping strategy analysis. Open positions still monitored.");
    const limitReason = checkTradeLimits._lastReason || "Circuit breaker tripped";
    await sendTelegram(
      `🛑 <b>Trading Paused</b>\n\n` +
      `${limitReason}\n\n` +
      `Open positions still monitored for TP/SL.` +
      buildPortfolioBlock(portfolio)
    );
    const summary = buildTelegramSummary(openTradeUpdates, portfolio);
    if (summary) await sendTelegram(summary);
    saveLog(log);
    console.log(`\nDecision log saved → ${LOG_FILE}`);
    console.log("═══════════════════════════════════════════════════════════\n");
    return;
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
          `Confidence: ${t.confidence === "HIGH" ? "🟢 HIGH" : "🟡 MEDIUM"} — ${t.confidenceReason || ""}\n` +
          `Entry: $${price.toFixed(2)}\n` +
          `SL: $${t.slPrice.toFixed(2)}\n` +
          `TP1: $${t.tp1.toFixed(2)} (${t.rr1.toFixed(1)}R)\n` +
          `TP2: $${t.tp2.toFixed(2)} (${t.rr2.toFixed(1)}R)\n` +
          `Size: $${tradeSize.toFixed(2)}` +
          (t.biasWarning ? `\n⚠️ HTF bias (${t.htfTrend}) conflicts — HIGH confidence override` : "")
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
