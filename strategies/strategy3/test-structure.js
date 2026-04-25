/**
 * Test: Structure Detector against live BTC 1H candles
 *
 * Fetches 500 candles from Binance and runs swing + BOS/CHoCH detection.
 * Prints results so we can visually verify the logic is correct.
 */

import { analyzeStructure } from "./structureDetector.js";

async function fetchCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.map((k) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function formatTime(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Structure Detector Test — BTC/USDT 1H");
  console.log("═══════════════════════════════════════════════════════════\n");

  const candles = await fetchCandles("BTCUSDT", "1h", 500);
  console.log(`Fetched ${candles.length} candles`);
  console.log(`Range: ${formatTime(candles[0].time)} → ${formatTime(candles[candles.length - 1].time)}\n`);

  // Run analysis with N=3 for HTF
  const result = analyzeStructure(candles, 3);

  // Print swing highs
  console.log("── Swing Highs (last 10) ────────────────────────────────\n");
  result.swingHighs.slice(-10).forEach((s) => {
    console.log(`  ${formatTime(s.time)}  $${s.price.toFixed(2)}  (index ${s.index}, confirmed at ${s.confirmedAt})`);
  });

  // Print swing lows
  console.log("\n── Swing Lows (last 10) ─────────────────────────────────\n");
  result.swingLows.slice(-10).forEach((s) => {
    console.log(`  ${formatTime(s.time)}  $${s.price.toFixed(2)}  (index ${s.index}, confirmed at ${s.confirmedAt})`);
  });

  // Print BOS and CHoCH events
  console.log("\n── Structure Events (last 15) ───────────────────────────\n");
  result.events.slice(-15).forEach((e) => {
    const icon = e.type === "CHoCH" ? "🔄" : "📈";
    const dir = e.direction === "bullish" ? "▲ BULL" : "▼ BEAR";
    console.log(`  ${icon} ${e.type} ${dir}  ${formatTime(e.time)}  broke $${e.brokenLevel.toFixed(2)}  closed $${e.closePrice.toFixed(2)}`);
  });

  // Current trend
  console.log(`\n── Current Trend: ${result.currentTrend.toUpperCase()} ──\n`);

  // Summary stats
  console.log("── Summary ─────────────────────────────────────────────\n");
  console.log(`  Total swing highs detected: ${result.swingHighs.length}`);
  console.log(`  Total swing lows detected:  ${result.swingLows.length}`);
  console.log(`  Total BOS events:           ${result.events.filter((e) => e.type === "BOS").length}`);
  console.log(`  Total CHoCH events:         ${result.events.filter((e) => e.type === "CHoCH").length}`);
  console.log(`  Current trend:              ${result.currentTrend}`);
  console.log("\n═══════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
