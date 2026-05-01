/**
 * Risk Manager — Position sizing, limits, and correlation filter
 *
 * Controls:
 * - Position size based on account equity and risk per trade
 * - Max concurrent positions across all strategies
 * - Max daily loss — halts new entries
 * - Correlation filter — no duplicate direction on correlated pairs
 */

import { readFileSync, existsSync } from "fs";
import CONFIG from "./config.js";

/**
 * Calculate position size based on risk parameters.
 *
 * Formula: size = (equity * riskPerTrade) / (entry - sl)
 * This ensures you risk exactly riskPerTrade% of equity per trade.
 *
 * @param {number} equity - account equity in USD
 * @param {number} entryPrice - planned entry price
 * @param {number} slPrice - stop loss price
 * @param {number} maxTradeSizeUSD - hard cap from .env
 * @returns {{ quantity: number, sizeUSD: number, riskUSD: number, riskPct: number }}
 */
export function calculatePositionSize(equity, entryPrice, slPrice, maxTradeSizeUSD) {
  const riskPerTrade = CONFIG.risk.riskPerTrade;
  const riskUSD = equity * riskPerTrade;
  const slDistance = Math.abs(entryPrice - slPrice);

  if (slDistance === 0) {
    return { quantity: 0, sizeUSD: 0, riskUSD: 0, riskPct: 0, error: "SL distance is zero" };
  }

  // Position size in USD
  let sizeUSD = (riskUSD / slDistance) * entryPrice;

  // Cap at max trade size
  sizeUSD = Math.min(sizeUSD, maxTradeSizeUSD);

  const quantity = sizeUSD / entryPrice;
  const actualRiskPct = (slDistance / entryPrice) * (sizeUSD / equity);

  return {
    quantity,
    sizeUSD,
    riskUSD,
    riskPct: actualRiskPct,
    slDistance,
    slDistancePct: (slDistance / entryPrice) * 100,
  };
}

/**
 * Calculate target prices (TP1, TP2) based on opposing liquidity.
 *
 * @param {string} direction - "bullish" or "bearish"
 * @param {number} entryPrice - entry price
 * @param {number} slPrice - stop loss price
 * @param {Array} opposingPools - liquidity pools on the opposite side
 * @param {number} atr - current ATR
 * @returns {{ tp1: number, tp2: number, rr1: number, rr2: number }}
 */
export function calculateTargets(direction, entryPrice, slPrice, opposingPools, atr) {
  const slDistance = Math.abs(entryPrice - slPrice);
  const fallbackRR = CONFIG.risk.fallbackRR;

  // Sort opposing pools by distance from entry
  const sorted = opposingPools
    .map((p) => ({
      ...p,
      distance: Math.abs(p.level - entryPrice),
    }))
    .sort((a, b) => a.distance - b.distance);

  let tp1, tp2;

  // Only use pools that give at least 1.5R — ignore ones too close to entry
  const minTPDist = slDistance * 1.5;

  if (direction === "bullish") {
    // TP targets are above entry
    const above = sorted.filter((p) => p.level > entryPrice && (p.level - entryPrice) >= minTPDist);

    tp1 = above.length > 0 ? above[0].level : entryPrice + fallbackRR * slDistance;
    tp2 = above.length > 1 ? above[1].level : entryPrice + (fallbackRR + 1) * slDistance;
  } else {
    // TP targets are below entry
    const below = sorted.filter((p) => p.level < entryPrice && (entryPrice - p.level) >= minTPDist);

    tp1 = below.length > 0 ? below[0].level : entryPrice - fallbackRR * slDistance;
    tp2 = below.length > 1 ? below[1].level : entryPrice - (fallbackRR + 1) * slDistance;
  }

  const rr1 = Math.abs(tp1 - entryPrice) / slDistance;
  const rr2 = Math.abs(tp2 - entryPrice) / slDistance;

  return { tp1, tp2, rr1, rr2 };
}

/**
 * Check all risk filters before allowing a trade.
 *
 * @param {string} symbol - trading pair
 * @param {string} direction - "bullish" or "bearish"
 * @param {Object} log - safety check log (trades today)
 * @param {number} equity - account equity
 * @returns {{ allowed: boolean, reasons: Array }}
 */
export function checkRiskFilters(symbol, direction, log, equity) {
  const reasons = [];
  const today = new Date().toISOString().slice(0, 10);

  // 1. Max concurrent positions
  const openPositions = log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced && t.strategy?.includes("Strategy 3"),
  );

  if (openPositions.length >= CONFIG.risk.maxConcurrentPositions) {
    reasons.push(`Max concurrent positions reached (${CONFIG.risk.maxConcurrentPositions})`);
  }

  // 2. Max daily loss
  const todayTrades = log.trades.filter((t) => t.timestamp.startsWith(today));
  const dailyPnL = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const dailyLossPct = Math.abs(Math.min(0, dailyPnL)) / equity;

  if (dailyLossPct >= CONFIG.risk.maxDailyLossPct) {
    reasons.push(`Max daily loss reached (${(dailyLossPct * 100).toFixed(2)}% >= ${CONFIG.risk.maxDailyLossPct * 100}%)`);
  }

  // 3. Correlation filter
  const correlatedPairs = CONFIG.correlation.groups.find((g) => g.includes(symbol));
  if (correlatedPairs) {
    const sameDirectionOnCorrelated = openPositions.filter(
      (t) =>
        correlatedPairs.includes(t.symbol) &&
        t.symbol !== symbol &&
        t.side === (direction === "bullish" ? "BUY" : "SELL"),
    );

    if (sameDirectionOnCorrelated.length > 0) {
      reasons.push(
        `Correlated pair ${sameDirectionOnCorrelated[0].symbol} already has same-direction position`,
      );
    }
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

/**
 * Model execution costs for realistic P&L tracking.
 *
 * @param {number} sizeUSD - trade size
 * @param {number} entryPrice - entry price
 * @param {boolean} isSweepCandle - if entering during a sweep (wider spread)
 * @returns {{ fee: number, slippage: number, totalCost: number, adjustedEntry: number }}
 */
export function modelExecutionCosts(sizeUSD, entryPrice, isSweepCandle = false) {
  const fee = sizeUSD * CONFIG.execution.takerFee;

  let slippage = entryPrice * CONFIG.execution.slippageModel;
  if (isSweepCandle) {
    slippage *= CONFIG.execution.sweepSpreadMultiplier;
  }

  const totalCost = fee + (slippage / entryPrice) * sizeUSD;
  const adjustedEntry = entryPrice + slippage; // worse fill

  return { fee, slippage, totalCost, adjustedEntry };
}
