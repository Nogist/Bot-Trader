/**
 * State Machine — Per-pair trade setup tracking
 *
 * States:
 *   IDLE → CONSOLIDATION_DETECTED → SWEEP_OCCURRED →
 *   AWAITING_CHOCH → AWAITING_ENTRY → IN_POSITION → COOLDOWN → IDLE
 *
 * Each state has a TTL. If the next condition doesn't happen in time,
 * the setup expires and returns to IDLE.
 *
 * State persists to disk so it survives bot restarts.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import CONFIG from "./config.js";

const STATES = {
  IDLE: "IDLE",
  CONSOLIDATION_DETECTED: "CONSOLIDATION_DETECTED",
  SWEEP_OCCURRED: "SWEEP_OCCURRED",
  AWAITING_CHOCH: "AWAITING_CHOCH",
  AWAITING_ENTRY: "AWAITING_ENTRY",
  IN_POSITION: "IN_POSITION",
  COOLDOWN: "COOLDOWN",
};

/**
 * Load persisted state from disk.
 * @returns {Object} - state per symbol
 */
function loadState() {
  const path = CONFIG.stateFile;
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Save state to disk.
 * @param {Object} state - full state object
 */
function saveState(state) {
  writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

/**
 * Get or initialize state for a symbol.
 * @param {Object} allState - full state object
 * @param {string} symbol - trading pair
 * @returns {Object} - symbol state
 */
function getSymbolState(allState, symbol) {
  if (!allState[symbol]) {
    allState[symbol] = {
      state: STATES.IDLE,
      enteredStateAt: null,
      candlesSinceStateChange: 0,
      setup: null,          // current setup data
      transitions: [],      // history of state changes
      position: null,       // active position data
    };
  }
  return allState[symbol];
}

/**
 * Transition to a new state.
 *
 * @param {Object} symbolState - current state for this symbol
 * @param {string} newState - target state
 * @param {Object} data - data that triggered the transition
 * @param {string} reason - human-readable reason
 */
function transition(symbolState, newState, data = {}, reason = "") {
  const oldState = symbolState.state;

  symbolState.transitions.push({
    from: oldState,
    to: newState,
    time: new Date().toISOString(),
    reason,
    data,
  });

  // Keep only last 50 transitions
  if (symbolState.transitions.length > 50) {
    symbolState.transitions = symbolState.transitions.slice(-50);
  }

  symbolState.state = newState;
  symbolState.enteredStateAt = new Date().toISOString();
  symbolState.candlesSinceStateChange = 0;

  return { from: oldState, to: newState, reason };
}

/**
 * Process the state machine for one symbol.
 *
 * Called every bot cycle. Evaluates current state, checks for transitions,
 * enforces TTLs, and returns an action if a trade should be placed.
 *
 * @param {string} symbol - trading pair
 * @param {Object} analysis - combined analysis from all detectors
 *   { consolidation, sweeps, structure, fvgs, orderBlocks, price, atr, htfTrend }
 * @returns {{ action: string|null, details: Object, stateTransitions: Array }}
 */
export function processStateMachine(symbol, analysis) {
  const allState = loadState();
  const symState = getSymbolState(allState, symbol);
  const stateTransitions = [];

  symState.candlesSinceStateChange++;

  const {
    consolidation,
    sweeps,
    structure,
    fvgs,
    orderBlocks,
    price,
    atr,
    htfTrend,
    ltfEvents,
  } = analysis;

  let action = null;
  let actionDetails = {};

  // ─── State: IDLE ─────────────────────────────────────────────────
  if (symState.state === STATES.IDLE) {
    // Look for consolidation
    if (consolidation && consolidation.active) {
      const t = transition(symState, STATES.CONSOLIDATION_DETECTED, {
        high: consolidation.high,
        low: consolidation.low,
        atrCompression: consolidation.atrCompression,
      }, "Consolidation range detected");
      stateTransitions.push(t);
    }
  }

  // ─── State: CONSOLIDATION_DETECTED ───────────────────────────────
  if (symState.state === STATES.CONSOLIDATION_DETECTED) {
    // Store consolidation range in setup
    if (!symState.setup) {
      symState.setup = {
        consolidation: consolidation || symState.setup?.consolidation,
      };
    }

    // Look for sweep of the consolidation range
    const sweepLookback = CONFIG.sweep.recencyLookback || 20;
    const recentSweeps = sweeps.filter(
      (s) => s.index >= (analysis.latestCandleIndex || 0) - sweepLookback,
    );

    if (recentSweeps.length > 0) {
      const sweep = recentSweeps[recentSweeps.length - 1];
      symState.setup.sweep = sweep;

      const t = transition(symState, STATES.SWEEP_OCCURRED, {
        direction: sweep.direction,
        level: sweep.level,
        wickRatio: sweep.wickRatio,
        volumeRatio: sweep.volumeRatio,
      }, `${sweep.poolType} swept at $${sweep.level.toFixed(2)}`);
      stateTransitions.push(t);
    }

    // Check if consolidation broke without a sweep — reset
    if (!consolidation?.active && symState.candlesSinceStateChange > 5) {
      const t = transition(symState, STATES.IDLE, {},
        "Consolidation broke without sweep — resetting");
      stateTransitions.push(t);
      symState.setup = null;
    }
  }

  // ─── State: SWEEP_OCCURRED ──────────────────────────────────────
  if (symState.state === STATES.SWEEP_OCCURRED) {
    // Check TTL
    if (symState.candlesSinceStateChange > CONFIG.stateTTL.sweepToChoch) {
      const t = transition(symState, STATES.IDLE, {},
        `No CHoCH within ${CONFIG.stateTTL.sweepToChoch} candles — setup expired`);
      stateTransitions.push(t);
      symState.setup = null;
    } else {
      // Look for CHoCH on LTF in the expected direction
      const expectedDir = symState.setup?.sweep?.direction;
      const recentChoch = (ltfEvents || []).filter(
        (e) => e.type === "CHoCH" && e.direction === expectedDir,
      );

      if (recentChoch.length > 0) {
        const choch = recentChoch[recentChoch.length - 1];
        symState.setup.choch = choch;

        const t = transition(symState, STATES.AWAITING_CHOCH, {
          direction: choch.direction,
          brokenLevel: choch.brokenLevel,
        }, `CHoCH ${choch.direction} confirmed after sweep`);
        stateTransitions.push(t);
      }
    }
  }

  // ─── State: AWAITING_CHOCH (confirming the CHoCH) ───────────────
  if (symState.state === STATES.AWAITING_CHOCH) {
    // Now look for FVG or OB entry zone
    const setupDir = symState.setup?.sweep?.direction;
    const relevantFVGs = (fvgs || []).filter(
      (f) => !f.invalidated && f.direction === setupDir,
    );
    const relevantOBs = (orderBlocks || []).filter(
      (ob) => !ob.invalidated && ob.direction === setupDir,
    );

    if (relevantFVGs.length > 0 || relevantOBs.length > 0) {
      // Pick the closest entry zone to current price
      const entryZone = pickBestEntryZone(relevantFVGs, relevantOBs, price, setupDir);

      if (entryZone) {
        symState.setup.entryZone = entryZone;

        const t = transition(symState, STATES.AWAITING_ENTRY, {
          zoneType: entryZone.type,
          high: entryZone.high,
          low: entryZone.low,
        }, `Entry zone found: ${entryZone.type} at $${entryZone.low.toFixed(2)}-$${entryZone.high.toFixed(2)}`);
        stateTransitions.push(t);
      }
    }

    // TTL check
    if (symState.candlesSinceStateChange > CONFIG.stateTTL.chochToEntry) {
      const t = transition(symState, STATES.IDLE, {},
        `No entry zone within ${CONFIG.stateTTL.chochToEntry} candles — expired`);
      stateTransitions.push(t);
      symState.setup = null;
    }
  }

  // ─── State: AWAITING_ENTRY ──────────────────────────────────────
  if (symState.state === STATES.AWAITING_ENTRY) {
    const zone = symState.setup?.entryZone;
    const setupDir = symState.setup?.sweep?.direction;

    if (zone) {
      // Check if price has reached the entry zone
      const inZone = price >= zone.low && price <= zone.high;

      // HTF bias check
      let biasAligned = true;
      if (CONFIG.bias.enabled && htfTrend) {
        biasAligned = htfTrend === setupDir || htfTrend === "undefined";
      }

      if (inZone && biasAligned) {
        // ENTRY SIGNAL
        const sweep = symState.setup.sweep;
        const slPrice = setupDir === "bullish"
          ? (sweep.sweepLow || sweep.level) - CONFIG.risk.slBufferMultiplier * atr
          : (sweep.sweepHigh || sweep.level) + CONFIG.risk.slBufferMultiplier * atr;

        action = "ENTER";
        actionDetails = {
          direction: setupDir,
          side: setupDir === "bullish" ? "buy" : "sell",
          entryPrice: price,
          slPrice,
          entryZone: zone,
          sweep: sweep,
          choch: symState.setup.choch,
          biasAligned,
          htfTrend,
        };

        symState.position = {
          direction: setupDir,
          entryPrice: price,
          slPrice,
          enteredAt: new Date().toISOString(),
        };

        const t = transition(symState, STATES.IN_POSITION, {
          entryPrice: price,
          slPrice,
          direction: setupDir,
        }, `Entering ${setupDir} at $${price.toFixed(2)}, SL $${slPrice.toFixed(2)}`);
        stateTransitions.push(t);

      } else if (!biasAligned) {
        const t = transition(symState, STATES.IDLE, {},
          `HTF bias (${htfTrend}) conflicts with setup (${setupDir}) — skipping`);
        stateTransitions.push(t);
        symState.setup = null;
      }
    }

    // TTL check
    if (symState.state === STATES.AWAITING_ENTRY &&
        symState.candlesSinceStateChange > CONFIG.stateTTL.entryToFill) {
      const t = transition(symState, STATES.IDLE, {},
        `Price didn't reach entry zone within ${CONFIG.stateTTL.entryToFill} candles — expired`);
      stateTransitions.push(t);
      symState.setup = null;
    }
  }

  // ─── State: IN_POSITION ─────────────────────────────────────────
  if (symState.state === STATES.IN_POSITION) {
    // Position management is handled by the execution layer
    // This state is maintained until the position is closed
    // (stop loss, take profit, or manual close)
  }

  // ─── State: COOLDOWN ────────────────────────────────────────────
  if (symState.state === STATES.COOLDOWN) {
    if (symState.candlesSinceStateChange >= CONFIG.stateTTL.cooldownHTFCandles) {
      const t = transition(symState, STATES.IDLE, {}, "Cooldown complete");
      stateTransitions.push(t);
      symState.setup = null;
    }
  }

  // Save state to disk
  saveState(allState);

  return {
    action,
    details: actionDetails,
    currentState: symState.state,
    stateTransitions,
    setup: symState.setup,
  };
}

/**
 * Move a symbol to cooldown state (called after position close).
 */
export function enterCooldown(symbol) {
  const allState = loadState();
  const symState = getSymbolState(allState, symbol);
  transition(symState, STATES.COOLDOWN, {}, "Position closed — entering cooldown");
  symState.position = null;
  symState.setup = null;
  saveState(allState);
}

/**
 * Reset a symbol to IDLE (manual reset).
 */
export function resetSymbol(symbol) {
  const allState = loadState();
  const symState = getSymbolState(allState, symbol);
  transition(symState, STATES.IDLE, {}, "Manual reset");
  symState.setup = null;
  symState.position = null;
  saveState(allState);
}

/**
 * Pick the best entry zone from available FVGs and OBs.
 */
function pickBestEntryZone(fvgs, obs, price, direction) {
  const zones = [
    ...fvgs.map((f) => ({
      type: "FVG",
      high: f.high,
      low: f.low,
      direction: f.direction,
      time: f.time,
      distance: direction === "bullish"
        ? price - f.high  // for longs, zone should be below price
        : f.low - price,  // for shorts, zone should be above price
    })),
    ...obs.map((ob) => ({
      type: "OB",
      high: ob.high,
      low: ob.low,
      direction: ob.direction,
      time: ob.time,
      distance: direction === "bullish"
        ? price - ob.high
        : ob.low - price,
    })),
  ];

  // Filter to zones in the right position relative to price
  // and sort by proximity (closest first)
  const valid = zones
    .filter((z) => z.distance >= 0)
    .sort((a, b) => a.distance - b.distance);

  return valid.length > 0 ? valid[0] : null;
}

export { STATES };
