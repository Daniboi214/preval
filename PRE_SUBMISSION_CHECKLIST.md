# Pre-Submission Checklist: PreVal (Stocklana Hackathon)

This checklist tracks temporary testing switches, development mock parameters, and verification items that MUST be cleaned up or confirmed before final submission.

## 1. Development Flags & Switches to Remove

- [ ] **`simulatePreStocks429` query parameter & body flag**:
  - Located in [`app/page.tsx`](file:///C:/Users/HomePC/.gemini/antigravity/scratch/preval/app/page.tsx) and [`app/api/quote/route.ts`](file:///C:/Users/HomePC/.gemini/antigravity/scratch/preval/app/api/quote/route.ts).
  - Currently protected behind:
    ```typescript
    const isDev = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_TESTING === 'true';
    const allowSimulation = isDev && Boolean(simulatePreStocks429);
    ```
  - Action before final submission: Strip out `simulatePreStocks429` logic entirely so only the real `fetchPreStocksTokensWithFallback()` runs.

- [ ] **`ENABLE_DEV_TESTING` Environment Variable**:
  - Confirmed: **Unset by default** in standard builds and `.env.local`.
  - Only used during local test harness runs. Ensure it is not defined in any deployment environment (e.g. Vercel dashboard).

## 2. Production Caching & Attribution

- [ ] **HTTP Caching**:
  - `Cache-Control: public, s-maxage=10, stale-while-revalidate=20` configured on `/api/quote`.
  - Works natively on Vercel's Edge Network (free tier includes shared Edge Cache per region).
- [ ] **Attribution Notice**:
  - Subheading explicitly reads: *"Quotes fetched via Jupiter and compared with PreStocks' mark prices"*.
- [ ] **Hard Guard Rules**:
  - Fails closed on quote errors (`RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `NO_ROUTE`).
  - Stale data (> 60s) strictly triggers `BLOCK` and disables Buy execution.

## 3. Vercel Serverless Architecture & Limitations Breakdown

- **Ephemeral / Read-Only Filesystem**:
  - Vercel serverless functions run in ephemeral container sandboxes where root repository files are read-only and `/tmp` is non-persistent across invocations.
  - Mitigation: `saveLastDryRun` and `getLastDryRunFallback` in [`src/dataLayer.js`](file:///C:/Users/HomePC/.gemini/antigravity/scratch/preval/src/dataLayer.js) are protected with `try/catch` wrappers. If disk writes fail, execution proceeds seamlessly with in-memory state and static fallback assets (`data/last_dry_run.json`) rather than crashing.

- **In-Memory Rate Limiting**:
  - In-memory rate limit maps (`simulateRateLimitMap`, `rpcRateLimitMap`) reside in container memory. In multi-instance or multi-region serverless deployments, memory is not shared between lambdas.
  - Status: Sufficient for demo and DDoS spike smoothing per container instance. Production multi-region scaling would integrate Upstash Redis / Vercel KV.

- **Function Timeouts**:
  - Vercel Hobby plan enforces a 10s max duration per function invocation (Pro is 15s/60s).
  - Mitigation: All 3 legs in `/api/basket/simulate` execute in parallel via `Promise.all` with strict 8-second timeouts per leg (`simulateLegWithTimeout`), keeping overall endpoint latency (~1.2s - 2.5s) safely under the 10s ceiling.

- **Node.js Runtime vs Edge Runtime**:
  - Endpoints run on the Node.js runtime (`nodejs`) rather than the Edge runtime to ensure complete compatibility with `@solana/web3.js`, `crypto`, and `Buffer` manipulation.

- **Environment Variables**:
  - Production deployments require setting environment variables in the Vercel Project Dashboard (Settings > Environment Variables):
    - `SOLANA_RPC_URL`: Required (mainnet RPC endpoint without key in public commits).
    - `DEMO_SIM_ADDRESS`: Required for dry-run simulation without user wallet.
    - `ENABLE_REAL_BUY`: Set to `false` (defaults to false).
    - `ENABLE_DEV_TESTING`: Must be left unset/false in production.

