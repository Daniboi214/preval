# PreVal

Buy the private AI & frontier-tech wave in one click, without overpaying.

PreVal is a guarded buying tool for [PreStocks](https://prestocks.com/) pre-IPO tokens on Solana. Before you buy, it checks the live trading price against PreStocks' own reference price, checks pool depth, and blocks or warns you when something looks wrong  instead of letting you buy blind.

**Live demo:** [https://preval-two.vercel.app]  
**Category:** Investing (index baskets, recurring buys) also submitted to the PreStocks bounty track  
**Built for:** Stocklana Hackathon, Solana Foundation

---

## The problem

Pre-IPO tokens for companies like OpenAI, Anthropic, and Anduril already trade on Solana via PreStocks — [$414M+ in volume since launch](https://prestocks.com/). But two things make buying them risky if you're not watching closely:

* **Price gaps.** The live trading price can drift well above PreStocks' own reference ("mark") price — we've seen tokens trade 15–30%+ over fair value during volatile moments. Nothing on the trading interface itself warns you about this before you buy.
* **Thin liquidity.** These are still early, low-volume markets. A quote can look fine, but selling back afterward can cost far more than expected.

Most tools that exist today are read-only dashboards — they show you the numbers, but you still have to do the math and decide yourself, every time.

---

## What PreVal does

PreVal is a buy button with a safety check built in, not just a dashboard:

* **Live price comparison** — pulls the real-time executable price from Jupiter and compares it against PreStocks' mark price, for every token, every few seconds.
* **A guard, not just a number.** Before any buy (single-token or basket) can execute, the app checks: premium vs. mark price, price impact, round-trip exit cost, and whether the quote is fresh. If a token fails, it's blocked — the transaction is never even built.
* **Honest, plain-language verdicts.** Instead of a wall of percentages, each token gets a short sentence: "Fair price — looks good," "Trading 12% above fair value," or a clear "Blocked: [reason]." Full technical detail (spread, impact, exit cost, venue, quote age) is one click away for anyone who wants it.
* **One-click basket buying.** Pick 2–3 tokens, set a budget, and PreVal splits it across them, checks each one, and executes (or simulates) the whole basket together — with a re-split option if one token gets blocked.
* **A real, verified live trade.** This isn't a mockup. We executed a real $1 swap on Solana mainnet through this exact code path — [see it on Solscan](https://solscan.io/tx/5xB98gsjyhkEe6w1orGYxZ6tvFFw3qtBcJiRN27XfCBGKGmPcBdjbV4dJya63uiegm58G4CYsByqx59BoSwNhQQ5).

---

## Try it without spending anything

The live site runs in preview mode (`ENABLE_REAL_BUY=false`) — real buying is off by default. You can:
* See live prices and guard verdicts for all 7 eligible PreStocks tokens
* Run a full dry-run simulation of a basket — real on-chain simulation, real numbers, nothing sent
* See exactly what a BLOCK, WARN, or PASS looks like and why

---

## Why this is hard to get right (and what we actually solved)

* PreStocks tokens use Token-2022 with a transfer fee that changed from 0.5% to 1% partway through building this — the app reads the active fee live from the mint, rather than hardcoding it.
* Jupiter's own price-impact estimate is noisy — we found it disagreeing with itself between identical requests. PreVal also measures its own empirical impact by comparing quotes at different sizes, and only blocks on the more reliable signal.
* Only 3 of PreStocks' trading venues (Meteora DLMM, Raydium CLMM, Manifest) are used — quotes and transactions are pinned to these; anything else is treated as unverified and blocked from live execution.
* Every prepared transaction is simulated and sanity-checked server-side before it's ever shown to a wallet for signing — fee payer, program IDs, and balance deltas are all verified.
* Stale data can never authorize a buy. If PreStocks' price feed is more than 60 seconds old, rate-limited, or unavailable, the app fails closed rather than guessing.

---

## Tech

* **Frontend:** Next.js, TypeScript, Tailwind
* **Data:** PreStocks API (mark prices, token metadata), Jupiter (live quotes, swap building), Solana RPC (on-chain reads, simulation)
* **Wallet:** Solana Wallet Adapter (Phantom)
* **Hosting:** Vercel

---

## Running it locally

```bash
npm install
cp .env.example .env.local # fill in SOLANA_RPC_URL and DEMO_SIM_ADDRESS
npm run dev
```

### Environment variables:

| Variable | Purpose |
| :--- | :--- |
| `SOLANA_RPC_URL` | Your Solana mainnet RPC endpoint |
| `DEMO_SIM_ADDRESS` | A funded public wallet used for read-only dry-run simulations (never signs anything) |
| `ENABLE_REAL_BUY` | `false` by default — set to `true` locally only if you want to test real signing with your own wallet |

### Run the test suite:

```bash
node --test test/dataLayer.test.js test/integration.test.js
```

---

## Risk disclosures

* Not available to US persons or residents of restricted jurisdictions.
* These tokens give economic price exposure only — not equity or shareholder rights in the underlying companies.
* The underlying legal structure is disputed: OpenAI and Anthropic have stated that the SPV share transfers behind these tokens are invalid.
* Markets are thin; selling back may cost more than a quote suggests.
* Token transfer fees are set by the issuer and can change.
* This is a tool, not investment or financial advice.

---

## Credits

Data via PreStocks and Jupiter. Built on Solana.
