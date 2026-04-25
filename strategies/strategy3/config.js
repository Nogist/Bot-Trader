/**
 * Strategy 3: SMC Liquidity Sweep — All configurable parameters
 *
 * Every magic number lives here. No hardcoded values in logic files.
 * Tune these to adjust sensitivity, risk, and trade frequency.
 */

const CONFIG = {
  // ─── Swing Point Detection ──────────────────────────────────────────
  swing: {
    htfLookback: 3,       // N candles each side to confirm a swing on HTF (4H)
    ltfLookback: 2,       // N candles each side to confirm a swing on LTF (5m/15m)
    maxSwingsStored: 20,  // rolling list of confirmed swing highs/lows per TF
  },

  // ─── Market Structure (BOS / CHoCH) ─────────────────────────────────
  structure: {
    // Trend starts as "undefined" until first BOS prints
    initialTrend: "undefined", // "bullish" | "bearish" | "undefined"
  },

  // ─── Consolidation Detection ────────────────────────────────────────
  consolidation: {
    lookback: 20,          // N candles to measure range
    rangeMultiplier: 3.5,  // range must be < X * ATR to be "consolidating"
    volCompressionRatio: 0.9, // current ATR must be < Y * 20-period ATR avg
    atrPeriod: 14,         // ATR period
    atrAvgPeriod: 20,      // period for ATR moving average comparison
  },

  // ─── Equal Highs / Equal Lows (Liquidity Pools) ────────────────────
  liquidity: {
    toleranceMultiplier: 0.15, // two highs are "equal" if within 0.15 * ATR
    minTouches: 2,             // minimum touches to form a valid pool
    minCandlesBetween: 5,      // min candles separating touches (avoid double-counting)
  },

  // ─── Sweep Detection ───────────────────────────────────────────────
  sweep: {
    minWickBodyRatio: 1.5,    // wick must be >= 1.5x the candle body
    minVolumeMultiplier: 1.3, // volume must be >= 1.3x the 20-period avg volume
    volumeAvgPeriod: 20,      // period for average volume calculation
    recencyLookback: 100,     // sweep must be within last N candles to be "recent" (100 * 1H = ~4 days)
  },

  // ─── FVG (Fair Value Gap) ──────────────────────────────────────────
  fvg: {
    minSizeMultiplier: 0.3,   // ignore FVGs smaller than 0.3 * ATR
    invalidationFill: 0.5,    // FVG invalidated when >50% filled by price
  },

  // ─── Order Block ───────────────────────────────────────────────────
  // OB = last opposing candle before impulse. Invalidated when price
  // closes through the opposite side.

  // ─── State Machine TTLs (in candles on LTF) ────────────────────────
  stateTTL: {
    sweepToChoch: 6,        // candles after sweep to see CHoCH, else expire
    chochToEntry: 12,       // candles after CHoCH to reach FVG/OB entry zone
    entryToFill: 20,        // candles waiting at entry zone before invalidation
    cooldownHTFCandles: 4,  // HTF candles to wait after closing a trade
  },

  // ─── HTF Bias Filter ──────────────────────────────────────────────
  bias: {
    enabled: true,          // toggle for A/B testing — false = skip bias filter
    htfTimeframes: ["4H"],  // timeframes to check for directional alignment
  },

  // ─── Risk Management ──────────────────────────────────────────────
  risk: {
    riskPerTrade: 0.005,       // 0.5% of account equity per trade
    maxConcurrentPositions: 3, // across ALL strategies
    maxDailyLossPct: 0.03,     // 3% daily loss halts new entries
    slBufferMultiplier: 0.2,   // SL = sweep wick + 0.2 * ATR buffer
    tp1Pct: 0.5,               // take 50% off at TP1
    fallbackRR: 3,             // if no opposing pool, use 3R as TP
    trailToBreakevenAfterTP1: true,
  },

  // ─── Execution Realism ────────────────────────────────────────────
  execution: {
    takerFee: 0.0004,          // 0.04% taker fee (Binance default)
    slippageModel: 0.0005,     // 0.05% worse fill assumed
    sweepSpreadMultiplier: 2,  // spread widens 2x during sweep candles
  },

  // ─── Correlation Filter ───────────────────────────────────────────
  correlation: {
    groups: [
      ["BTCUSDT", "ETHUSDT"],  // correlated pairs — don't take same direction
    ],
  },

  // ─── Timeframes ───────────────────────────────────────────────────
  timeframes: {
    htf: "1H",   // higher timeframe for consolidation + sweep detection
    ltf: "5m",   // lower timeframe for CHoCH + entry
  },

  // ─── State Persistence ────────────────────────────────────────────
  stateFile: "strategies/strategy3/state.json",
};

export default CONFIG;
