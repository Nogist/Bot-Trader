/**
 * Key Levels — Shared dynamic R:R module
 *
 * Reuses S3's detectors to find support/resistance levels, then calculates
 * smart SL/TP targets for any strategy. No duplication — one source of truth.
 *
 * Used by: S1 (VWAP), S2 (EMA Crossover), and S3 (SMC) as fallback.
 */

import { detectSwingPoints } from "../strategies/strategy3/structureDetector.js";
import { calcATR } from "../strategies/strategy3/consolidationDetector.js";
import { detectLiquidityPools } from "../strategies/strategy3/liquidityDetector.js";

const MIN_RR = 1.5; // skip trade if best R:R is below this

/**
 * Find dynamic SL/TP targets based on chart structure.
 *
 * @param {Array} candles - OHLCV candle array (any timeframe)
 * @param {number} entryPrice - planned entry price
 * @param {string} side - "BUY" or "SELL"
 * @returns {{ sl, tp1, tp2, rr1, rr2, slDist, atr, skipTrade, levels }}
 */
export function findDynamicTargets(candles, entryPrice, side) {
  if (!candles || candles.length < 30) {
    return fallbackTargets(entryPrice, side, null);
  }

  const { swingHighs, swingLows } = detectSwingPoints(candles, 3, 20);
  const atr = calcATR(candles);
  if (!atr) return fallbackTargets(entryPrice, side, null);

  // Find liquidity pools (stronger than plain swings)
  let eqHighs = [], eqLows = [];
  try {
    const pools = detectLiquidityPools(swingHighs, swingLows, atr);
    eqHighs = pools.eqHighs;
    eqLows = pools.eqLows;
  } catch {
    // Liquidity detection is optional — fall through with empty pools
  }

  // Build resistance levels above entry (sorted nearest first)
  const resistance = [
    ...swingHighs.map((s) => ({ price: s.price, type: "swing_high", strength: 1 })),
    ...eqHighs.map((p) => ({ price: p.level, type: "EQH", strength: p.touches })),
  ]
    .filter((l) => l.price > entryPrice + atr * 0.1) // must be meaningfully above
    .sort((a, b) => a.price - b.price);

  // Deduplicate nearby levels (within 0.3 ATR — keep strongest)
  const resistanceDeduped = deduplicateLevels(resistance, atr);

  // Build support levels below entry (sorted nearest first)
  const support = [
    ...swingLows.map((s) => ({ price: s.price, type: "swing_low", strength: 1 })),
    ...eqLows.map((p) => ({ price: p.level, type: "EQL", strength: p.touches })),
  ]
    .filter((l) => l.price < entryPrice - atr * 0.1) // must be meaningfully below
    .sort((a, b) => b.price - a.price);

  const supportDeduped = deduplicateLevels(support, atr);

  let sl, tp1, tp2;
  const sideUp = side.toUpperCase();

  if (sideUp === "BUY") {
    // SL below nearest support with small ATR buffer
    sl = supportDeduped.length > 0
      ? supportDeduped[0].price - atr * 0.2
      : entryPrice - atr * 1.5;

    // TP at resistance levels
    tp1 = resistanceDeduped.length > 0
      ? resistanceDeduped[0].price
      : null;

    tp2 = resistanceDeduped.length > 1
      ? resistanceDeduped[1].price
      : null;
  } else {
    // SL above nearest resistance with buffer
    sl = resistanceDeduped.length > 0
      ? resistanceDeduped[0].price + atr * 0.2
      : entryPrice + atr * 1.5;

    // TP at support levels
    tp1 = supportDeduped.length > 0
      ? supportDeduped[0].price
      : null;

    tp2 = supportDeduped.length > 1
      ? supportDeduped[1].price
      : null;
  }

  const slDist = Math.abs(entryPrice - sl);

  // Fallback TPs if no key levels found
  if (!tp1) tp1 = sideUp === "BUY" ? entryPrice + slDist * 2 : entryPrice - slDist * 2;
  if (!tp2) tp2 = sideUp === "BUY" ? entryPrice + slDist * 3 : entryPrice - slDist * 3;

  const rr1 = slDist > 0 ? Math.abs(tp1 - entryPrice) / slDist : 0;
  const rr2 = slDist > 0 ? Math.abs(tp2 - entryPrice) / slDist : 0;

  // Skip trade if R:R is below minimum threshold
  const skipTrade = rr1 < MIN_RR;

  return {
    sl, tp1, tp2, rr1, rr2, slDist, atr, skipTrade,
    levels: {
      resistance: resistanceDeduped.slice(0, 5),
      support: supportDeduped.slice(0, 5),
    },
  };
}

/**
 * Fallback when not enough candle data for key level detection.
 * Uses fixed ATR-based or percentage-based targets.
 */
function fallbackTargets(entryPrice, side, atr) {
  const slDist = atr ? atr * 1.5 : entryPrice * 0.015;
  const sideUp = (side || "BUY").toUpperCase();
  const sl = sideUp === "BUY" ? entryPrice - slDist : entryPrice + slDist;
  const tp1 = sideUp === "BUY" ? entryPrice + slDist * 2 : entryPrice - slDist * 2;
  const tp2 = sideUp === "BUY" ? entryPrice + slDist * 3 : entryPrice - slDist * 3;

  return {
    sl, tp1, tp2,
    rr1: 2, rr2: 3,
    slDist, atr,
    skipTrade: false,
    levels: { resistance: [], support: [] },
  };
}

/**
 * Merge levels that are within 0.3×ATR of each other.
 * Keeps the one with higher strength (more touches).
 */
function deduplicateLevels(levels, atr) {
  const merged = [];
  const tolerance = atr * 0.3;

  for (const level of levels) {
    const existing = merged.find((m) => Math.abs(m.price - level.price) < tolerance);
    if (existing) {
      // Keep the stronger one
      if (level.strength > existing.strength) {
        existing.price = level.price;
        existing.type = level.type;
        existing.strength = level.strength;
      }
    } else {
      merged.push({ ...level });
    }
  }

  return merged;
}
