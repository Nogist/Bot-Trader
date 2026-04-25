/**
 * Liquidity Detector — Equal Highs/Lows (pools) + Sweep Detection
 *
 * Identifies liquidity pools where stop orders cluster (equal highs/lows),
 * then detects when market makers sweep those levels.
 *
 * Liquidity pool: 2+ swing highs/lows at the same price level (ATR-scaled tolerance)
 * Sweep: wick beyond a pool with close back inside + volume + wick ratio confirmation
 */

import CONFIG from "./config.js";
import { calcATR } from "./consolidationDetector.js";

/**
 * Detect Equal Highs (EQH) and Equal Lows (EQL) — liquidity pools.
 *
 * Two swings are "equal" if their prices are within tolerance * ATR of each other,
 * and they are separated by at least minCandlesBetween candles.
 *
 * @param {Array} swingHighs - from structureDetector
 * @param {Array} swingLows - from structureDetector
 * @param {number} atr - current ATR value
 * @returns {{ eqHighs: Array, eqLows: Array }}
 */
export function detectLiquidityPools(swingHighs, swingLows, atr) {
  const { toleranceMultiplier, minTouches, minCandlesBetween } = CONFIG.liquidity;
  const tolerance = toleranceMultiplier * atr;

  const eqHighs = findEqualLevels(swingHighs, "high", tolerance, minTouches, minCandlesBetween);
  const eqLows = findEqualLevels(swingLows, "low", tolerance, minTouches, minCandlesBetween);

  return { eqHighs, eqLows };
}

/**
 * Find equal price levels among swing points.
 *
 * Groups swings whose prices are within tolerance of each other,
 * ensuring minimum candle separation between touches.
 *
 * @param {Array} swings - swing points [{price, index, time}]
 * @param {string} type - "high" or "low"
 * @param {number} tolerance - max price difference to be "equal"
 * @param {number} minTouches - minimum touches to form a pool
 * @param {number} minCandlesBetween - minimum candles between touches
 * @returns {Array} - liquidity pools
 */
function findEqualLevels(swings, type, tolerance, minTouches, minCandlesBetween) {
  const pools = [];
  const used = new Set();

  for (let i = 0; i < swings.length; i++) {
    if (used.has(i)) continue;

    const group = [swings[i]];
    used.add(i);

    for (let j = i + 1; j < swings.length; j++) {
      if (used.has(j)) continue;

      // Check price is within tolerance
      if (Math.abs(swings[j].price - swings[i].price) > tolerance) continue;

      // Check minimum candle separation from last touch in group
      const lastInGroup = group[group.length - 1];
      if (Math.abs(swings[j].index - lastInGroup.index) < minCandlesBetween) continue;

      group.push(swings[j]);
      used.add(j);
    }

    if (group.length >= minTouches) {
      const avgPrice = group.reduce((sum, s) => sum + s.price, 0) / group.length;

      pools.push({
        type,  // "high" or "low"
        level: avgPrice,
        touches: group.length,
        touchPoints: group.map((s) => ({
          price: s.price,
          index: s.index,
          time: s.time,
        })),
        firstSeen: group[0].time,
        lastSeen: group[group.length - 1].time,
        swept: false,
        sweptAt: null,
      });
    }
  }

  return pools;
}

/**
 * Detect sweeps of known liquidity pools.
 *
 * A sweep occurs when:
 * 1. Candle wick extends beyond a known EQH/EQL level
 * 2. Candle closes back inside the prior range
 * 3. Wick-to-body ratio >= configured minimum
 * 4. Volume >= configured multiplier * average volume
 * 5. The pool has sufficient touches
 *
 * @param {Array} candles - OHLCV candle array
 * @param {Array} eqHighs - equal high pools from detectLiquidityPools
 * @param {Array} eqLows - equal low pools from detectLiquidityPools
 * @param {number} atr - current ATR
 * @returns {Array} - sweep events
 */
export function detectSweeps(candles, eqHighs, eqLows, atr) {
  const { minWickBodyRatio, minVolumeMultiplier, volumeAvgPeriod } = CONFIG.sweep;
  const sweeps = [];

  // Pre-calculate rolling average volume
  const avgVolumes = [];
  for (let i = 0; i < candles.length; i++) {
    const start = Math.max(0, i - volumeAvgPeriod + 1);
    const slice = candles.slice(start, i + 1);
    avgVolumes.push(slice.reduce((sum, c) => sum + c.volume, 0) / slice.length);
  }

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i];
    const body = Math.abs(candle.close - candle.open);
    const avgVol = avgVolumes[i];

    // Check each EQH pool for a sweep above
    for (const pool of eqHighs) {
      if (pool.swept) continue;

      // Only check candles after the pool formed
      const lastTouchIndex = pool.touchPoints[pool.touchPoints.length - 1].index;
      if (i <= lastTouchIndex) continue;

      // Wick above the level
      if (candle.high > pool.level) {
        const upperWick = candle.high - Math.max(candle.open, candle.close);
        const closeBackInside = candle.close < pool.level;
        const wickRatio = body > 0 ? upperWick / body : upperWick > 0 ? Infinity : 0;
        const volumeOk = candle.volume >= minVolumeMultiplier * avgVol;

        if (closeBackInside && wickRatio >= minWickBodyRatio && volumeOk) {
          pool.swept = true;
          pool.sweptAt = candle.time;

          sweeps.push({
            direction: "bearish",  // swept highs → expect bearish reversal
            poolType: "EQH",
            level: pool.level,
            sweepHigh: candle.high,
            closePrice: candle.close,
            index: i,
            time: candle.time,
            wickRatio: wickRatio,
            volumeRatio: candle.volume / avgVol,
            touches: pool.touches,
            pool,
          });
        }
      }
    }

    // Check each EQL pool for a sweep below
    for (const pool of eqLows) {
      if (pool.swept) continue;

      const lastTouchIndex = pool.touchPoints[pool.touchPoints.length - 1].index;
      if (i <= lastTouchIndex) continue;

      // Wick below the level
      if (candle.low < pool.level) {
        const lowerWick = Math.min(candle.open, candle.close) - candle.low;
        const closeBackInside = candle.close > pool.level;
        const wickRatio = body > 0 ? lowerWick / body : lowerWick > 0 ? Infinity : 0;
        const volumeOk = candle.volume >= minVolumeMultiplier * avgVol;

        if (closeBackInside && wickRatio >= minWickBodyRatio && volumeOk) {
          pool.swept = true;
          pool.sweptAt = candle.time;

          sweeps.push({
            direction: "bullish",  // swept lows → expect bullish reversal
            poolType: "EQL",
            level: pool.level,
            sweepLow: candle.low,
            closePrice: candle.close,
            index: i,
            time: candle.time,
            wickRatio: wickRatio,
            volumeRatio: candle.volume / avgVol,
            touches: pool.touches,
            pool,
          });
        }
      }
    }
  }

  return sweeps;
}

/**
 * Full liquidity analysis — find pools and detect sweeps.
 *
 * @param {Array} candles - OHLCV candle array
 * @param {Array} swingHighs - from structureDetector
 * @param {Array} swingLows - from structureDetector
 * @returns {{ eqHighs, eqLows, sweeps, atr }}
 */
export function analyzeLiquidity(candles, swingHighs, swingLows) {
  const atr = calcATR(candles);
  if (!atr) return { eqHighs: [], eqLows: [], sweeps: [], atr: null };

  const { eqHighs, eqLows } = detectLiquidityPools(swingHighs, swingLows, atr);
  const sweeps = detectSweeps(candles, eqHighs, eqLows, atr);

  return { eqHighs, eqLows, sweeps, atr };
}
