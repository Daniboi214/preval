# Pre-Submission Notes (PreVal — Stocklana Hackathon)

Quick notes to myself on what to double check before I submit.

## Dev switches — make sure these are off

- There's a `simulatePreStocks429` flag I added in `app/page.tsx` and `app/api/quote/route.ts` to test what happens if PreStocks rate-limits us. It's locked behind `ENABLE_DEV_TESTING=true`, which I never set in production, so it can't be triggered on the live site. Still on my list to just delete this before final submission instead of leaving it gated.
- `ENABLE_DEV_TESTING` — not set anywhere in `.env.local` or in Vercel. Only used locally when I was testing the rate-limit banner. Double check it's not accidentally added to the Vercel dashboard.

## Caching / attribution

- `/api/quote` caches for 10s and serves stale-while-revalidate for 20s, so we're not hammering PreStocks or Jupiter on every page load. Runs fine on Vercel's free tier.
- The app credits its data sources in the subheading ("Quotes fetched via Jupiter and compared with PreStocks' mark prices") — want to keep that honest and visible.
- If PreStocks data is older than 60 seconds, or if a quote errors out, buying gets blocked automatically. No stale-price trades.

## Things I had to work around on Vercel

- **Files can't be written to on Vercel** (serverless functions run in a read-only sandbox). So `saveLastDryRun`/`getLastDryRunFallback` just fail quietly and fall back to a static snapshot file (`data/last_dry_run.json`) instead of crashing.
- **Rate limiting only works per-instance**, not globally — Vercel can spin up multiple copies of the app, and they don't share memory. Fine for a demo, wouldn't be enough at real scale without something like Redis.
- **10-second function timeout** on the free plan. The 3-leg basket simulation runs all legs in parallel with an 8s cap each, so it stays well under that.
- Using the Node.js runtime, not Edge — needed it for the Solana libraries to work properly.

## Environment variables (set in Vercel dashboard, not in the repo)

- `SOLANA_RPC_URL` — my RPC endpoint (kept out of git, obviously)
- `DEMO_SIM_ADDRESS` — a funded public wallet used only for read-only simulations, so people can try the dry run without connecting their own wallet
- `ENABLE_REAL_BUY=false` — live buying is off on the public site, on purpose
- `ENABLE_DEV_TESTING` — left unset in production
