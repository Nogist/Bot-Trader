/**
 * Consolidation Detector — ATR-based range detection
 *
 * Detects when price is consolidating (range-bound) by comparing:
 * 1. Price range over N candles vs current ATR
 * 2. Current ATR vs its own moving average (volatility compression)
 *
 * Uses ATR scaling, NOT fixed percentages — works across volatility regimes.
 */

import CONFIG from "./config.js";

/**
 * Calculate ATR (Average True Range) for a set of candles.
 *
 * @param {Array} candles - OHLCV candle array
 * @param {number} period - ATR period
 * @returns {number|null} - current ATR value
 */
export function calcATR(candles, period = CONFIG.consolidation.atrPeriod) {
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

/**
 * Calculate a series of ATR values for computing ATR moving average.
 *
 * @param {Array} candles - OHLCV candle array
 * @param {number} period - ATR period
 * @returns {Array<number>} - array of ATR values
 */
export function calcATRSeries(candles, period = CONFIG.consolidation.atrPeriod) {
  if (candles.length < period + 1) return [];

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }

  const atrSeries = [];
  for (let i = period - 1; i < trs.length; i++) {
    const slice = trs.slice(i - period + 1, i + 1);
    atrSeries.push(slice.reduce((a, b) => a + b, 0) / period);
  }

  return atrSeries;
}

/**
 * Detect consolidation zones in candle data.
 *
 * A consolidation is detected when:
 * 1. Price range over last N candles < rangeMultiplier * ATR
 * 2. Current ATR < volCompressionRatio * average ATR over longer period
 *
 * @param {Array} candles - OHLCV candle array
 * @returns {{ isConsolidating: boolean, zones: Array, currentATR: number, avgATR: number }}
 */
export function detectConsolidation(candles) {
  const {
    lookback,
    rangeMultiplier,
    volCompressionRatio,
    atrPeriod,
    atrAvgPeriod,
  } = CONFIG.consolidation;

  if (candles.length < lookback + atrAvgPeriod) {
    return { isConsolidating: false, zones: [], currentATR: null, avgATR: null };
  }

  const currentATR = calcATR(candles, atrPeriod);
  const atrSeries = calcATRSeries(candles, atrPeriod);

  if (!currentATR || atrSeries.length < atrAvgPeriod) {
    return { isConsolidating: false, zones: [], currentATR, avgATR: null };
  }

  // Average ATR over longer period
  const recentATRs = atrSeries.slice(-atrAvgPeriod);
  const avgATR = recentATRs.reduce((a, b) => a + b, 0) / recentATRs.length;

  const zones = [];

  // Scan for consolidation zones — slide a window of `lookback` candles
  for (let i = lookback; i <= candles.length; i++) {
    const window = candles.slice(i - lookback, i);
    const windowHigh = Math.max(...window.map((c) => c.high));
    const windowLow = Math.min(...window.map((c) => c.low));
    const range = windowHigh - windowLow;

    // Calculate ATR at this point in the series
    const atrIndex = i - atrPeriod - 1;
    const localATR = atrIndex >= 0 && atrIndex < atrSeries.length
      ? atrSeries[atrIndex]
      : currentATR;

    // Calculate local ATR average for compression check
    const localAvgStart = Math.max(0, atrIndex - atrAvgPeriod + 1);
    const localAvgSlice = atrSeries.slice(localAvgStart, atrIndex + 1);
    const localAvgATR = localAvgSlice.length > 0
      ? localAvgSlice.reduce((a, b) => a + b, 0) / localAvgSlice.length
      : avgATR;

    // Check both conditions
    const rangeCompressed = range < rangeMultiplier * localATR;
    const volCompressed = localATR < volCompressionRatio * localAvgATR;

    if (rangeCompressed && volCompressed) {
      zones.push({
        startIndex: i - lookback,
        endIndex: i - 1,
        startTime: window[0].time,
        endTime: window[window.length - 1].time,
        high: windowHigh,
        low: windowLow,
        range,
        atr: localATR,
        avgATR: localAvgATR,
        rangeToATR: range / localATR,
        atrCompression: localATR / localAvgATR,
      });
    }
  }

  // Merge overlapping zones into continuous consolidation periods
  const mergedZones = mergeZones(zones);

  // Check if the CURRENT candles are in consolidation
  const lastZone = mergedZones.length > 0
    ? mergedZones[mergedZones.length - 1]
    : null;
  const isConsolidating = lastZone
    ? lastZone.endIndex >= candles.length - lookback
    : false;

  return {
    isConsolidating,
    zones: mergedZones,
    currentATR,
    avgATR,
    atrCompression: currentATR / avgATR,
  };
}

/**
 * Merge overlapping consolidation zones into continuous periods.
 *
 * @param {Array} zones - raw zone detections (may overlap)
 * @returns {Array} - merged zones
 */
function mergeZones(zones) {
  if (zones.length === 0) return [];

  const merged = [{ ...zones[0] }];

  for (let i = 1; i < zones.length; i++) {
    const current = zones[i];
    const last = merged[merged.length - 1];

    // If this zone overlaps or is adjacent to the last, extend it
    if (current.startIndex <= last.endIndex + 1) {
      last.endIndex = Math.max(last.endIndex, current.endIndex);
      last.endTime = current.endTime;
      last.high = Math.max(last.high, current.high);
      last.low = Math.min(last.low, current.low);
      last.range = last.high - last.low;
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

/**
 * Get the current consolidation range if one is active.
 *
 * @param {Array} candles - OHLCV candle array
 * @returns {{ active: boolean, high: number, low: number, range: number, atr: number }|null}
 */
export function getCurrentConsolidation(candles) {
  const result = detectConsolidation(candles);

  if (!result.isConsolidating || result.zones.length === 0) {
    return null;
  }

  const zone = result.zones[result.zones.length - 1];
  return {
    active: true,
    high: zone.high,
    low: zone.low,
    range: zone.range,
    startTime: zone.startTime,
    endTime: zone.endTime,
    startIndex: zone.startIndex,
    endIndex: zone.endIndex,
    atr: result.currentATR,
    avgATR: result.avgATR,
    atrCompression: result.atrCompression,
  };
}
