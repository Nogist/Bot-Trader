/**
 * FVG and Order Block Detector
 *
 * FVG (Fair Value Gap): imbalance between candles where price didn't trade.
 *   - Bullish FVG: candle[i-2].high < candle[i].low (gap up)
 *   - Bearish FVG: candle[i-2].low > candle[i].high (gap down)
 *
 * Order Block (OB): last opposing candle before an impulse move.
 *   - Bullish OB: last down-close candle before a bullish impulse (BOS/FVG)
 *   - Bearish OB: last up-close candle before a bearish impulse
 *
 * Both track mitigation/invalidation as price returns to them.
 */

import CONFIG from "./config.js";
import { calcATR } from "./consolidationDetector.js";

/**
 * Detect Fair Value Gaps in candle data.
 *
 * @param {Array} candles - OHLCV candle array
 * @param {number} atr - current ATR (for min size filter)
 * @returns {Array} - FVG objects
 */
export function detectFVGs(candles, atr) {
  const { minSizeMultiplier } = CONFIG.fvg;
  const minSize = minSizeMultiplier * atr;
  const fvgs = [];

  for (let i = 2; i < candles.length; i++) {
    const candle0 = candles[i - 2]; // two candles back
    const candle1 = candles[i - 1]; // impulse candle
    const candle2 = candles[i];     // current candle

    const impulseBody = Math.abs(candle1.close - candle1.open);

    // Bullish FVG: gap up — candle0.high < candle2.low
    if (candle0.high < candle2.low) {
      const gapSize = candle2.low - candle0.high;
      if (gapSize >= minSize) {
        fvgs.push({
          direction: "bullish",
          high: candle2.low,     // top of the gap
          low: candle0.high,     // bottom of the gap
          size: gapSize,
          sizeToATR: gapSize / atr,
          impulseSize: impulseBody / atr,
          index: i - 1,          // impulse candle index
          time: candle1.time,
          fillPct: 0,
          invalidated: false,
          mitigatedAt: null,
        });
      }
    }

    // Bearish FVG: gap down — candle0.low > candle2.high
    if (candle0.low > candle2.high) {
      const gapSize = candle0.low - candle2.high;
      if (gapSize >= minSize) {
        fvgs.push({
          direction: "bearish",
          high: candle0.low,     // top of the gap
          low: candle2.high,     // bottom of the gap
          size: gapSize,
          sizeToATR: gapSize / atr,
          impulseSize: impulseBody / atr,
          index: i - 1,
          time: candle1.time,
          fillPct: 0,
          invalidated: false,
          mitigatedAt: null,
        });
      }
    }
  }

  // Track mitigation — check subsequent candles filling the gap
  for (const fvg of fvgs) {
    for (let i = fvg.index + 2; i < candles.length; i++) {
      const c = candles[i];

      if (fvg.direction === "bullish") {
        // Price returns down into the gap
        if (c.low <= fvg.high) {
          const filled = Math.min(fvg.high, Math.max(c.low, fvg.low));
          const fillAmount = fvg.high - filled;
          fvg.fillPct = Math.max(fvg.fillPct, fillAmount / fvg.size);

          if (fvg.fillPct >= CONFIG.fvg.invalidationFill) {
            fvg.invalidated = true;
            fvg.mitigatedAt = c.time;
            break;
          }
        }
      } else {
        // Price returns up into the gap
        if (c.high >= fvg.low) {
          const filled = Math.max(fvg.low, Math.min(c.high, fvg.high));
          const fillAmount = filled - fvg.low;
          fvg.fillPct = Math.max(fvg.fillPct, fillAmount / fvg.size);

          if (fvg.fillPct >= CONFIG.fvg.invalidationFill) {
            fvg.invalidated = true;
            fvg.mitigatedAt = c.time;
            break;
          }
        }
      }
    }
  }

  return fvgs;
}

/**
 * Detect Order Blocks in candle data.
 *
 * Bullish OB: last down-close candle before a bullish impulse
 * Bearish OB: last up-close candle before a bearish impulse
 *
 * An "impulse" is defined as a candle whose body > 1.0 * ATR (strong move).
 *
 * @param {Array} candles - OHLCV candle array
 * @param {number} atr - current ATR
 * @param {Array} structureEvents - BOS/CHoCH events from structureDetector
 * @returns {Array} - Order Block objects
 */
export function detectOrderBlocks(candles, atr, structureEvents) {
  const orderBlocks = [];

  // For each BOS or CHoCH event, find the last opposing candle before it
  for (const event of structureEvents) {
    const impulseIndex = event.index;

    if (event.direction === "bullish") {
      // Look backwards for the last down-close candle before this bullish break
      for (let i = impulseIndex - 1; i >= Math.max(0, impulseIndex - 10); i--) {
        const c = candles[i];
        if (c.close < c.open) {
          // Found a bearish candle — this is the bullish OB
          orderBlocks.push({
            direction: "bullish",
            high: c.high,
            low: c.low,
            open: c.open,
            close: c.close,
            index: i,
            time: c.time,
            triggerEvent: event.type,
            invalidated: false,
            invalidatedAt: null,
          });
          break;
        }
      }
    } else if (event.direction === "bearish") {
      // Look backwards for the last up-close candle before this bearish break
      for (let i = impulseIndex - 1; i >= Math.max(0, impulseIndex - 10); i--) {
        const c = candles[i];
        if (c.close > c.open) {
          // Found a bullish candle — this is the bearish OB
          orderBlocks.push({
            direction: "bearish",
            high: c.high,
            low: c.low,
            open: c.open,
            close: c.close,
            index: i,
            time: c.time,
            triggerEvent: event.type,
            invalidated: false,
            invalidatedAt: null,
          });
          break;
        }
      }
    }
  }

  // Track invalidation — OB is invalidated when price closes through the opposite side
  for (const ob of orderBlocks) {
    for (let i = ob.index + 1; i < candles.length; i++) {
      const c = candles[i];

      if (ob.direction === "bullish" && c.close < ob.low) {
        ob.invalidated = true;
        ob.invalidatedAt = c.time;
        break;
      }

      if (ob.direction === "bearish" && c.close > ob.high) {
        ob.invalidated = true;
        ob.invalidatedAt = c.time;
        break;
      }
    }
  }

  return orderBlocks;
}

/**
 * Get active (non-invalidated) FVGs and OBs near current price.
 *
 * @param {Array} fvgs - all detected FVGs
 * @param {Array} orderBlocks - all detected OBs
 * @param {number} price - current price
 * @param {number} atr - current ATR
 * @returns {{ activeFVGs: Array, activeOBs: Array }}
 */
export function getActiveZones(fvgs, orderBlocks, price, atr) {
  const proximityRange = 3 * atr; // only return zones within 3 ATR of current price

  const activeFVGs = fvgs.filter(
    (f) =>
      !f.invalidated &&
      Math.abs((f.high + f.low) / 2 - price) < proximityRange,
  );

  const activeOBs = orderBlocks.filter(
    (ob) =>
      !ob.invalidated &&
      Math.abs((ob.high + ob.low) / 2 - price) < proximityRange,
  );

  return { activeFVGs, activeOBs };
}
