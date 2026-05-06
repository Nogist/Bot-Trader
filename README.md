# Bot Trader

---

## What This Does

**Five things you get from this setup:**

1. **Automated exchange execution** — reads market data, evaluates your strategy, and executes trades on BitGet automatically
2. **A safety check** — every condition in your strategy must pass before a single trade goes through
3. **24/7 cloud execution** — deploy to Railway and it runs on a schedule, even when your laptop is closed
4. **Automatic tax accounting** — every trade logged to `trades.csv` with date, price, fees, and net amount, ready for your accountant
5. **Free** — no email, no course, no upsell. Everything is in this repo.

---

## The One-Shot Prompt

> **This is the main onboarding prompt.** Open Claude Code in this directory, paste the entire contents of [`prompts/02-one-shot-trade.md`](prompts/02-one-shot-trade.md), and follow the setup flow.

Here's what it does when you run it:

| Step | What the workflow does |
|------|-----------------|
| 1 | Reads your `rules.json` strategy |
| 2 | Pulls live price + indicator data from TradingView |
| 3 | Calculates MACD from raw candle data |
| 4 | Evaluates market bias (bullish / bearish / neutral) |
| 4b | Checks trade limits — daily cap and max trade size |
| 5 | Runs the safety check — every entry condition checked |
| 6 | Executes the trade via BitGet if all conditions pass |
| 7 | Logs the trade to `trades.csv` — date, price, fees, net amount (tax-ready) |
| 8 | Saves full decision log to `safety-check-log.json` |

If anything fails the safety check, it stops and tells you exactly which condition failed and the actual values. No trade goes through unless everything lines up.

---

## Getting Started

### Step 1 — Paste the one-shot prompt into Claude Code

Copy the entire contents of [`prompts/02-one-shot-trade.md`](prompts/02-one-shot-trade.md) and paste it into your Claude Code terminal.

That prompt walks through the initial setup: connecting BitGet, setting trading preferences, wiring up TradingView if you use it, optionally generating a strategy from transcript input, deploying to Railway, and running the bot for the first time.

---

## What's Happening Under the Hood

For anyone who wants to understand the steps manually, or troubleshoot a specific part:

### Prerequisites

- **TradingView MCP** set up already if you plan to use the local TradingView-assisted workflow
- **Claude Code** installed and running
- **A BitGet account**
- **Node.js 18+** — check with `node --version`

---

### Clone the repo

**Mac / Linux:**
```bash
git clone https://github.com/Nogist/Bot-Trader.git
cd Bot-Trader
```

**Windows:**
```powershell
git clone https://github.com/Nogist/Bot-Trader.git
cd Bot-Trader
```

---

### Add your BitGet API credentials

**Mac / Linux:**
```bash
cp .env.example .env
```

**Windows:**
```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in:

```
BITGET_API_KEY=your_api_key_here
BITGET_SECRET_KEY=your_secret_key_here
BITGET_PASSPHRASE=your_passphrase_here
PORTFOLIO_VALUE_USD=1000
MAX_TRADE_SIZE_USD=100
MAX_TRADES_PER_DAY=3
```

**Getting your API key:**

Step-by-step guides for all supported exchanges:

| Exchange | Guide |
|----------|-------|
| BitGet | [docs/exchanges/bitget.md](docs/exchanges/bitget.md) |
| Binance | [docs/exchanges/binance.md](docs/exchanges/binance.md) |
| Bybit | [docs/exchanges/bybit.md](docs/exchanges/bybit.md) |
| OKX | [docs/exchanges/okx.md](docs/exchanges/okx.md) |
| Coinbase Advanced | [docs/exchanges/coinbase.md](docs/exchanges/coinbase.md) |
| Kraken | [docs/exchanges/kraken.md](docs/exchanges/kraken.md) |
| KuCoin | [docs/exchanges/kucoin.md](docs/exchanges/kucoin.md) |
| Gate.io | [docs/exchanges/gateio.md](docs/exchanges/gateio.md) |
| MEXC | [docs/exchanges/mexc.md](docs/exchanges/mexc.md) |
| Bitfinex | [docs/exchanges/bitfinex.md](docs/exchanges/bitfinex.md) |

Two rules that apply to every exchange — **withdrawals OFF, IP whitelist ON**.

---

### Launch TradingView and connect the MCP

**Mac:**
```bash
tv_launch
tv_health_check
```

**Windows:** See [docs/setup-windows.md](docs/setup-windows.md)

**Linux:** See [docs/setup-linux.md](docs/setup-linux.md)

Verify with `tv_health_check` — should return `cdp_connected: true`.

---

### Run the bot manually

```bash
node bot.js
```

---

## Deploy to Railway (Run in the Cloud 24/7)

The local setup runs when your laptop is open. Railway lets the bot check for setups around the clock — even while you sleep.

> **Note:** Cloud mode pulls candle data directly from Binance's free market API instead of TradingView. No TradingView Desktop needed in the cloud. The strategy logic and safety check are identical.

### 1. Deploy

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### 2. Set your environment variables in Railway

Go to your Railway project → Variables and add everything from `.env.example`:

| Variable | Example |
|----------|---------|
| `BITGET_API_KEY` | your key |
| `BITGET_SECRET_KEY` | your secret |
| `BITGET_PASSPHRASE` | your passphrase |
| `PORTFOLIO_VALUE_USD` | 1000 |
| `MAX_TRADE_SIZE_USD` | 100 |
| `MAX_TRADES_PER_DAY` | 3 |
| `PAPER_TRADING` | true (set to false when ready) |
| `SYMBOL` | BTCUSDT |
| `TIMEFRAME` | 4H |

### 3. Set a cron schedule

In Railway → Settings → Cron Schedule, set how often the bot runs. Recommended:

| Timeframe | Schedule | What it means |
|-----------|----------|----------------|
| 4H chart | `0 */4 * * *` | Every 4 hours |
| 1D chart | `0 9 * * *` | Once a day at 9am UTC |
| 1H chart | `0 * * * *` | Every hour |

### 4. Start in paper trading mode

`PAPER_TRADING=true` logs every decision but never places real orders. Watch a few days of paper trades, confirm the logic matches what you expect, then flip it to `false`.

---

## Build Your Own Strategy (Optional)

The example `rules.json` contains starter strategies. You can also build your own from public market commentary or transcript data:

1. Export or collect the transcript/source material you want to base the strategy on
2. Paste the output into `prompts/01-extract-strategy.md`
3. Run that prompt in Claude Code — it generates a `rules.json` tailored to that methodology

---

## Files

| File | What it does |
|------|-------------|
| `rules.json` | Your strategy — indicators, entry rules, risk rules |
| `.env` | Your BitGet credentials (gitignored — never commits) |
| `prompts/01-extract-strategy.md` | Build rules.json from trader transcripts |
| `prompts/02-one-shot-trade.md` | **The one-shot prompt — paste this to trade** |
| `safety-check-log.json` | Auto-generated log of every trade decision |
| `trades.csv` | Tax-ready trade record — auto-written on every execution |
| `docs/setup-windows.md` | Windows-specific MCP setup |
| `docs/setup-linux.md` | Linux-specific MCP setup |

---

## Tax Accounting

Every trade the bot places is automatically written to `trades.csv` with the columns your accountant needs:

| Column | Description |
|--------|-------------|
| Date | ISO date of the trade |
| Time | UTC time |
| Exchange | BitGet |
| Symbol | e.g. BTCUSDT |
| Side | Buy / Sell |
| Quantity | Units traded |
| Price | Price per unit at execution |
| Total USD | Gross trade value |
| Fee (est.) | Estimated exchange fee |
| Net Amount | Total USD minus fee |
| Order ID | Exchange reference |
| Mode | Paper / Live |

At tax time: open the file, hand it to your accountant, or import it directly into your accounting software. Nothing to reconstruct.

For a quick summary of your trading activity, run:

```bash
node bot.js --tax-summary
```

This prints total trades, volume, and fees paid.

---

## Safety

The safety check conditions are not fixed — they come directly from your `rules.json`. If you build a strategy from transcripts or other source material, the safety check will reflect that entry logic. If you use the example strategy, it reflects those conditions. They're yours, not a generic filter.

Every condition in your `entry_rules` must pass before a trade goes through. One fails — nothing happens. The bot tells you exactly which condition failed and the actual value it saw.

Additional guardrails that apply regardless of strategy:
- Maximum trade size capped at `MAX_TRADE_SIZE_USD` in `.env`
- Maximum trades per day capped at `MAX_TRADES_PER_DAY` in `.env`
- Position sizing calculated from your portfolio value — max 1% risk per trade
- Every decision logged to `safety-check-log.json` with exact indicator values
- Every executed trade recorded in `trades.csv` for accounting

**This is not financial advice.** Build your strategy properly. Run the backtest. Paper trade before going live. Never put in more than you can afford to lose.

---

## Resources

- [Railway](https://railway.app/)
- [BitGet API Docs](https://www.bitget.com/api-doc/common/intro)
- [TradingView](https://www.tradingview.com/)
