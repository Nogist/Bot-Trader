/**
 * Structure Detector — Swing Points, BOS, and CHoCH
 *
 * This is the foundation. Every other detector depends on this being correct.
 *
 * Swing High: candle whose high exceeds the high of N candles on each side
 * Swing Low:  candle whose low is below the low of N candles on each side
 * BOS:  price closes beyond most recent swing in direction of existing trend
 * CHoCH: first break against the prevailing trend direction
 */

import CONFIG from "./config.js";

/**
 * Detect swing highs and lows from candle data using fractal definition.
 *
 * A swing high is confirmed when a candle's high is higher than N candles
 * on both sides. The swing is only "confirmed" N candles AFTER it prints.
 *
 * @param {Array} candles - OHLCV candle array [{time, open, high, low, close, volume}]
 * @param {number} lookback - N candles each side (default from config)
 * @param {number} maxSwings - max swings to keep in rolling list
 * @returns {{ swingHighs: Array, swingLows: Array }}
 */
export function detectSwingPoints(candles, lookback = null, maxSwings = null) {
  const N = lookback ?? CONFIG.swing.htfLookback;
  const max = maxSwings ?? CONFIG.swing.maxSwingsStored;

  const swingHighs = [];
  const swingLows = [];

  // We need at least N candles on each side, so start at index N
  // and stop N candles before the end
  for (let i = N; i < candles.length - N; i++) {
    const candle = candles[i];

    // Check swing high: candle[i].high must be > all N candles on each side
    let isSwingHigh = true;
    for (let j = 1; j <= N; j++) {
      if (candles[i - j].high >= candle.high || candles[i + j].high >= candle.high) {
        isSwingHigh = false;
        break;
      }
    }

    // Check swing low: candle[i].low must be < all N candles on each side
    let isSwingLow = true;
    for (let j = 1; j <= N; j++) {
      if (candles[i - j].low <= candle.low || candles[i + j].low <= candle.low) {
        isSwingLow = false;
        break;
      }
    }

    if (isSwingHigh) {
      swingHighs.push({
        price: candle.high,
        index: i,
        time: candle.time,
        confirmedAt: i + N, // confirmed N candles after it prints
      });
    }

    if (isSwingLow) {
      swingLows.push({
        price: candle.low,
        index: i,
        time: candle.time,
        confirmedAt: i + N,
      });
    }
  }

  // Keep only the most recent `max` swings
  return {
    swingHighs: swingHighs.slice(-max),
    swingLows: swingLows.slice(-max),
  };
}

/**
 * Detect market structure — BOS and CHoCH events.
 *
 * Walks through candles sequentially, tracking trend state.
 * - BOS: price closes beyond the most recent swing in the SAME direction as trend
 * - CHoCH: FIRST break against the prevailing trend
 *
 * @param {Array} candles - OHLCV candle array
 * @param {Array} swingHighs - confirmed swing highs from detectSwingPoints
 * @param {Array} swingLows - confirmed swing lows from detectSwingPoints
 * @returns {{ events: Array, currentTrend: string }}
 */
export function detectStructure(candles, swingHighs, swingLows) {
  const events = [];
  let currentTrend = CONFIG.structure.initialTrend; // "undefined" | "bullish" | "bearish"

  // Build a timeline of all swings sorted by index
  const allSwings = [
    ...swingHighs.map((s) => ({ ...s, type: "high" })),
    ...swingLows.map((s) => ({ ...s, type: "low" })),
  ].sort((a, b) => a.index - b.index);

  // Track the most recent confirmed swing high and low
  let lastSwingHigh = null;
  let lastSwingLow = null;

  // Track which swings have been broken (avoid duplicate BOS on same swing)
  const brokenSwings = new Set();

  // Walk through each candle and check for structure breaks
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Update the latest confirmed swings at this point in time
    for (const swing of allSwings) {
      if (swing.confirmedAt <= i) {
        if (swing.type === "high") lastSwingHigh = swing;
        if (swing.type === "low") lastSwingLow = swing;
      }
    }

    // Check for bullish break (close above last swing high)
    if (lastSwingHigh && !brokenSwings.has(`high-${lastSwingHigh.index}`)) {
      if (candle.close > lastSwingHigh.price) {
        brokenSwings.add(`high-${lastSwingHigh.index}`);

        if (currentTrend === "bullish" || currentTrend === "undefined") {
          // BOS — continuation of bullish trend (or first structure break)
          events.push({
            type: "BOS",
            direction: "bullish",
            index: i,
            time: candle.time,
            brokenLevel: lastSwingHigh.price,
            closePrice: candle.close,
            swingIndex: lastSwingHigh.index,
          });
          currentTrend = "bullish";
        } else {
          // CHoCH — first bullish break in a bearish trend
          events.push({
            type: "CHoCH",
            direction: "bullish",
            index: i,
            time: candle.time,
            brokenLevel: lastSwingHigh.price,
            closePrice: candle.close,
            swingIndex: lastSwingHigh.index,
          });
          currentTrend = "bullish";
        }
      }
    }

    // Check for bearish break (close below last swing low)
    if (lastSwingLow && !brokenSwings.has(`low-${lastSwingLow.index}`)) {
      if (candle.close < lastSwingLow.price) {
        brokenSwings.add(`low-${lastSwingLow.index}`);

        if (currentTrend === "bearish" || currentTrend === "undefined") {
          // BOS — continuation of bearish trend
          events.push({
            type: "BOS",
            direction: "bearish",
            index: i,
            time: candle.time,
            brokenLevel: lastSwingLow.price,
            closePrice: candle.close,
            swingIndex: lastSwingLow.index,
          });
          currentTrend = "bearish";
        } else {
          // CHoCH — first bearish break in a bullish trend
          events.push({
            type: "CHoCH",
            direction: "bearish",
            index: i,
            time: candle.time,
            brokenLevel: lastSwingLow.price,
            closePrice: candle.close,
            swingIndex: lastSwingLow.index,
          });
          currentTrend = "bearish";
        }
      }
    }
  }

  return { events, currentTrend };
}

/**
 * Get complete structure analysis for a set of candles.
 * Convenience function that runs both detectors.
 *
 * @param {Array} candles - OHLCV candle array
 * @param {number} lookback - swing detection lookback (optional)
 * @returns {{ swingHighs, swingLows, events, currentTrend }}
 */
export function analyzeStructure(candles, lookback = null) {
  const { swingHighs, swingLows } = detectSwingPoints(candles, lookback);
  const { events, currentTrend } = detectStructure(candles, swingHighs, swingLows);

  return { swingHighs, swingLows, events, currentTrend };
}
