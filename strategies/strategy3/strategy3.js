/**
 * Strategy 3: SMC Liquidity Sweep — Main Orchestrator
 *
 * Combines all detectors and the state machine into a single run() function
 * that bot.js calls. Returns a trade decision with full reasoning chain.
 *
 * Flow:
 * 1. Fetch HTF candles → detect structure + consolidation + liquidity
 * 2. Fetch LTF candles → detect structure for CHoCH confirmation
 * 3. Run state machine → determine if setup is actionable
 * 4. If entry signal → calculate position size, targets, risk
 * 5. Return decision with full audit trail
 */

import CONFIG from "./config.js";
import { analyzeStructure } from "./structureDetector.js";
import { detectConsolidation, getCurrentConsolidation, calcATR } from "./consolidationDetector.js";
import { analyzeLiquidity } from "./liquidityDetector.js";
import { detectFVGs, detectOrderBlocks, getActiveZones } from "./fvgDetector.js";
import { processStateMachine, enterCooldown } from "./stateMachine.js";
import { calculatePositionSize, calculateTargets, checkRiskFilters, modelExecutionCosts } from "./riskManager.js";

/**
 * Run Strategy 3 on a single symbol.
 *
 * @param {string} symbol - trading pair (e.g. "BTCUSDT")
 * @param {Function} fetchCandles - candle fetcher function from bot.js
 * @param {Object} log - safety check log
 * @param {number} equity - portfolio value in USD
 * @param {number} maxTradeSizeUSD - max trade size from .env
 * @returns {Object} - complete decision with audit trail
 */
export async function run(symbol, fetchCandles, log, equity, maxTradeSizeUSD) {
  const result = {
    strategy: "Strategy 3: SMC Liquidity Sweep",
    symbol,
    timestamp: new Date().toISOString(),
    htf: { timeframe: CONFIG.timeframes.htf },
    ltf: { timeframe: CONFIG.timeframes.ltf },
    decision: null,
    action: null,
    trade: null,
    auditTrail: [],
    filters: [],
  };

  const audit = (msg) => {
    result.auditTrail.push({ time: new Date().toISOString(), msg });
    console.log(`  📋 ${msg}`);
  };

  try {
    // ─── Step 1: HTF Analysis ─────────────────────────────────────
    console.log(`\n── HTF Analysis (${CONFIG.timeframes.htf}) ──────────────────────────────\n`);

    const htfCandles = await fetchCandles(symbol, CONFIG.timeframes.htf, 500);
    if (!htfCandles || htfCandles.length < 100) {
      audit("Not enough HTF candles. Skipping.");
      result.decision = "SKIP";
      return result;
    }

    const htfPrice = htfCandles[htfCandles.length - 1].close;
    const htfATR = calcATR(htfCandles);
    audit(`Price: $${htfPrice.toFixed(2)} | ATR: $${htfATR?.toFixed(2) || "N/A"}`);

    // Structure (swings, BOS, CHoCH)
    const htfStructure = analyzeStructure(htfCandles, CONFIG.swing.htfLookback);
    audit(`HTF Trend: ${htfStructure.currentTrend} | Swings: ${htfStructure.swingHighs.length}H / ${htfStructure.swingLows.length}L`);
    audit(`Structure events: ${htfStructure.events.length} (${htfStructure.events.filter((e) => e.type === "CHoCH").length} CHoCH, ${htfStructure.events.filter((e) => e.type === "BOS").length} BOS)`);

    // Consolidation
    const consolidation = getCurrentConsolidation(htfCandles);
    if (consolidation) {
      audit(`CONSOLIDATION ACTIVE: $${consolidation.low.toFixed(2)} - $${consolidation.high.toFixed(2)} (range: $${consolidation.range.toFixed(2)}, ATR compression: ${consolidation.atrCompression.toFixed(2)})`);
    } else {
      audit("No active consolidation on HTF");
    }

    // Liquidity pools + sweeps
    const liquidity = analyzeLiquidity(htfCandles, htfStructure.swingHighs, htfStructure.swingLows);
    audit(`Liquidity pools: ${liquidity.eqHighs.length} EQH, ${liquidity.eqLows.length} EQL`);

    if (liquidity.sweeps.length > 0) {
      const lastSweep = liquidity.sweeps[liquidity.sweeps.length - 1];
      audit(`Last sweep: ${lastSweep.poolType} ${lastSweep.direction} at $${lastSweep.level.toFixed(2)} (wick ratio: ${lastSweep.wickRatio.toFixed(2)}, vol: ${lastSweep.volumeRatio.toFixed(2)}x)`);
    } else {
      audit("No sweeps detected");
    }

    // FVGs and Order Blocks
    const htfFVGs = detectFVGs(htfCandles, htfATR);
    const htfOBs = detectOrderBlocks(htfCandles, htfATR, htfStructure.events);
    const { activeFVGs, activeOBs } = getActiveZones(htfFVGs, htfOBs, htfPrice, htfATR);
    audit(`Active zones near price: ${activeFVGs.length} FVGs, ${activeOBs.length} OBs`);

    // ─── Step 2: LTF Analysis ─────────────────────────────────────
    console.log(`\n── LTF Analysis (${CONFIG.timeframes.ltf}) ──────────────────────────────\n`);

    const ltfCandles = await fetchCandles(symbol, CONFIG.timeframes.ltf, 500);
    let ltfStructure = { events: [], currentTrend: "undefined" };

    if (ltfCandles && ltfCandles.length >= 50) {
      ltfStructure = analyzeStructure(ltfCandles, CONFIG.swing.ltfLookback);
      audit(`LTF Trend: ${ltfStructure.currentTrend} | Recent events: ${ltfStructure.events.slice(-5).map((e) => `${e.type} ${e.direction}`).join(", ") || "none"}`);
    } else {
      audit("Not enough LTF candles for structure analysis");
    }

    // ─── Step 3: State Machine ────────────────────────────────────
    console.log(`\n── State Machine ───────────────────────────────────────\n`);

    const smResult = processStateMachine(symbol, {
      consolidation,
      sweeps: liquidity.sweeps,
      structure: htfStructure,
      fvgs: activeFVGs,
      orderBlocks: activeOBs,
      price: htfPrice,
      atr: htfATR,
      htfTrend: htfStructure.currentTrend,
      ltfEvents: ltfStructure.events.slice(-10),
      latestCandleIndex: htfCandles.length - 1,
      htfCandles,
    });

    audit(`State: ${smResult.currentState}`);
    smResult.stateTransitions.forEach((t) => {
      audit(`  ${t.from} → ${t.to}: ${t.reason}`);
    });

    // ─── Step 4: Trade Decision ──────────────────────────────────
    console.log(`\n── Decision ────────────────────────────────────────────\n`);

    if (smResult.action === "ENTER") {
      const d = smResult.details;

      // Risk filter check
      const riskCheck = checkRiskFilters(symbol, d.direction, log, equity);
      result.filters = riskCheck.reasons;

      if (!riskCheck.allowed) {
        audit(`BLOCKED by risk filter: ${riskCheck.reasons.join(", ")}`);
        result.decision = "BLOCKED";
        result.action = null;
        return result;
      }

      // Position sizing
      const sizing = calculatePositionSize(equity, d.entryPrice, d.slPrice, maxTradeSizeUSD);
      audit(`Position size: $${sizing.sizeUSD.toFixed(2)} (${sizing.quantity.toFixed(6)} units)`);
      audit(`Risk: $${sizing.riskUSD.toFixed(2)} (${(sizing.riskPct * 100).toFixed(2)}% of equity)`);
      audit(`SL distance: $${sizing.slDistance.toFixed(2)} (${sizing.slDistancePct.toFixed(2)}%)`);

      // Targets
      const opposingPools = d.direction === "bullish"
        ? liquidity.eqHighs.filter((p) => !p.swept)
        : liquidity.eqLows.filter((p) => !p.swept);

      const targets = calculateTargets(d.direction, d.entryPrice, d.slPrice, opposingPools, htfATR);
      audit(`TP1: $${targets.tp1.toFixed(2)} (${targets.rr1.toFixed(1)}R) | TP2: $${targets.tp2.toFixed(2)} (${targets.rr2.toFixed(1)}R)`);

      // Minimum R:R gate — don't risk more than potential reward
      // Higher bar when trading against HTF trend (bias conflict = shallower targets)
      const MIN_S3_RR = d.biasWarning ? 2.0 : 1.5;
      if (targets.rr1 < MIN_S3_RR) {
        const slDist = Math.abs(d.entryPrice - d.slPrice);
        const tpDist = Math.abs(targets.tp1 - d.entryPrice);
        const biasNote = d.biasWarning ? ` (raised from 1.5R — trading against ${d.htfTrend} HTF trend)` : "";
        audit(`BLOCKED: R:R too low — TP1 is ${targets.rr1.toFixed(1)}R (need ${MIN_S3_RR}R min${biasNote}). Risking $${slDist.toFixed(2)} to make $${tpDist.toFixed(2)}`);
        result.decision = "BLOCKED";
        return result;
      }

      // Execution costs
      const costs = modelExecutionCosts(sizing.sizeUSD, d.entryPrice, false);
      audit(`Est. fees: $${costs.fee.toFixed(4)} | Slippage: $${costs.slippage.toFixed(4)}`);

      result.decision = "ENTER";
      result.action = d.side;
      result.trade = {
        direction: d.direction,
        side: d.side,
        entryPrice: d.entryPrice,
        slPrice: d.slPrice,
        tp1: targets.tp1,
        tp2: targets.tp2,
        rr1: targets.rr1,
        rr2: targets.rr2,
        sizeUSD: sizing.sizeUSD,
        quantity: sizing.quantity,
        riskUSD: sizing.riskUSD,
        riskPct: sizing.riskPct,
        fees: costs.fee,
        slippage: costs.slippage,
        entryZone: d.entryZone,
        sweep: {
          level: d.sweep?.level,
          type: d.sweep?.poolType,
          wickRatio: d.sweep?.wickRatio,
          volumeRatio: d.sweep?.volumeRatio,
        },
        htfTrend: d.htfTrend,
        biasAligned: d.biasAligned,
        biasWarning: d.biasWarning || false,
        confidence: d.confidence,
        confidenceReason: d.confidenceReason,
      };

      const confIcon = d.confidence === "HIGH" ? "🟢" : "🟡";
      const biasNote = d.biasWarning ? ` ⚠️ bias: ${d.htfTrend}` : "";
      console.log(`  ✅ ENTRY SIGNAL: ${d.side.toUpperCase()} ${symbol}`);
      console.log(`     Confidence: ${confIcon} ${d.confidence} — ${d.confidenceReason}${biasNote}`);
      console.log(`     Entry: $${d.entryPrice.toFixed(2)}`);
      console.log(`     SL:    $${d.slPrice.toFixed(2)}`);
      console.log(`     TP1:   $${targets.tp1.toFixed(2)} (${targets.rr1.toFixed(1)}R)`);
      console.log(`     TP2:   $${targets.tp2.toFixed(2)} (${targets.rr2.toFixed(1)}R)`);
      console.log(`     Size:  $${sizing.sizeUSD.toFixed(2)}`);
    } else {
      result.decision = "NO_SETUP";
      audit(`No actionable setup. State: ${smResult.currentState}`);
      console.log(`  ⏳ No trade — ${smResult.currentState}`);
    }

    result.htf.trend = htfStructure.currentTrend;
    result.htf.atr = htfATR;
    result.htf.price = htfPrice;
    result.ltf.trend = ltfStructure.currentTrend;

  } catch (err) {
    audit(`ERROR: ${err.message}`);
    result.decision = "ERROR";
    result.error = err.message;
    console.log(`  ❌ Error: ${err.message}`);
  }

  return result;
}

export { enterCooldown };
