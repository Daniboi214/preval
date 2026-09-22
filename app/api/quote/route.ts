import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  fetchPreStocksTokensWithFallback,
  fetchMintMetadata,
  fetchJupiterQuoteCached,
  calculateTokenMetrics,
  evaluateGuard,
  calculateBasketAllocations,
  classifyVenue,
  USDC_MINT,
  DEFAULT_RPC_URL
} from '@/src/dataLayer.js';

function getRpcUrl(): string {
  const envRpc = process.env.SOLANA_RPC_URL?.trim();
  if (envRpc && !envRpc.includes('PASTE_YOUR_KEY_HERE')) {
    return envRpc;
  }
  return DEFAULT_RPC_URL;
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      totalUsdc = 15,
      selectedSymbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'],
      maxPremium = 5.0,
      maxPriceImpact = 2.0,
      warnExitLoss = 3.0,
      simulatePreStocks429 = false
    } = body;

    // Validate and cap requested amount: min $0.10/leg up to $25 safety cap
    const rawTotalUsdc = Number(totalUsdc);
    const requestedTotalUsdc = Number.isFinite(rawTotalUsdc) && rawTotalUsdc > 0 ? rawTotalUsdc : 15;
    const minAllowedUsdc = 0.10 * Math.max(1, Array.isArray(selectedSymbols) ? selectedSymbols.length : 1);
    const cappedUsdc = Math.min(Math.max(minAllowedUsdc, requestedTotalUsdc), 25);
    const isClamped = cappedUsdc !== requestedTotalUsdc;
    const clampNote = isClamped
      ? (requestedTotalUsdc < minAllowedUsdc
          ? `Requested $${requestedTotalUsdc.toFixed(2)} USDC was clamped to minimum $${minAllowedUsdc.toFixed(2)} USDC ($0.10/leg)`
          : `Requested $${requestedTotalUsdc.toFixed(2)} USDC was clamped to maximum safety cap $25.00 USDC`)
      : null;

    // DEV-ONLY SWITCH: simulatePreStocks429 is strictly ignored in production builds
    // MUST BE REMOVED BEFORE FINAL SUBMISSION
    const isDev = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_TESTING === 'true';
    const allowSimulation = isDev && Boolean(simulatePreStocks429);

    // Fetch token catalog with 60s cache + 15m stale-if-error + retry-after backoff
    const tokenFetchResult = allowSimulation
      ? {
          tokens: (await import('@/src/dataLayer.js')).STATIC_PRESTOCKS_SNAPSHOT,
          dataAgeSeconds: 184, // 3 minutes stale
          isStale: true,
          isRateLimited: true,
          rateLimitCooldownSeconds: 45,
          source: 'stale-429-simulated'
        }
      : await fetchPreStocksTokensWithFallback();

    const isSnapshotSourced = tokenFetchResult.source === 'snapshot' || tokenFetchResult.source?.includes('snapshot');
    const isDataStale = tokenFetchResult.isStale || (tokenFetchResult.dataAgeSeconds && tokenFetchResult.dataAgeSeconds > 60) || isSnapshotSourced;
    if (isDataStale) {
      tokenFetchResult.isStale = true;
    }

    const allTokens: any[] = tokenFetchResult.tokens;
    const tokenMap = new Map<string, any>(allTokens.map((t: any) => [t.symbol, t]));

    // Filter strictly to valid selected symbols (quote ONLY selected tokens)
    const validSymbols = selectedSymbols.filter((s: string) => tokenMap.has(s));
    if (validSymbols.length === 0) {
      return NextResponse.json({ error: 'No valid tokens selected' }, { status: 400 });
    }

    const allocations = calculateBasketAllocations(cappedUsdc, validSymbols);
    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    const quoteTimestamp = Date.now();
    const tokenResults = [];
    let commonFeeScheduleNote = 'token transfer fee: 0.50% (rising to 1.00% at epoch 1039, in ~14 hours)';

    // Process tokens sequentially with small pause to avoid rate limiting
    for (const symbol of validSymbols) {
      const token = tokenMap.get(symbol);
      const legUsdc = allocations[symbol] || 0;
      const legLamports = Math.floor(legUsdc * 1e6);
      const oneDollarLamports = 1 * 1e6;

      // 1. On-chain metadata, multiplier & active fee
      const metadata = await fetchMintMetadata(
        connection,
        new PublicKey(token.contract_address)
      );
      if (metadata.feeScheduleNote) {
        commonFeeScheduleNote = metadata.feeScheduleNote;
      }

      // 2. Buy quote for requested leg amount (cached + deduplicated)
      const buyQuoteResult = await fetchJupiterQuoteCached(
        USDC_MINT,
        token.contract_address,
        legLamports,
        true
      );

      // 3. Buy quote for $1 (to measure empirical impact)
      const oneDollarQuoteResult = await fetchJupiterQuoteCached(
        USDC_MINT,
        token.contract_address,
        oneDollarLamports,
        true
      );

      // Measure routes and venue
      const routeAtX = buyQuoteResult.ok
        ? buyQuoteResult.data.routePlan?.[0]?.swapInfo?.label || 'Direct'
        : '';
      const routeAt1 = oneDollarQuoteResult.ok
        ? oneDollarQuoteResult.data.routePlan?.[0]?.swapInfo?.label || 'Direct'
        : '';

      const venueInfo = classifyVenue(routeAtX);
      const feeDeductedBeyondQuote = venueInfo.feeDeductedBeyondQuote;
      const activeFeePct = (metadata.activeFeeBps || 50) / 10000;

      // Calculate empirical price impact ($X vs $1)
      let empiricalPriceImpactPct = 0;
      if (buyQuoteResult.ok && oneDollarQuoteResult.ok) {
        const rawTokens1 = parseFloat(oneDollarQuoteResult.data.outAmount) / Math.pow(10, metadata.decimals);
        const netTokens1 = feeDeductedBeyondQuote ? rawTokens1 * (1 - activeFeePct) : rawTokens1;
        const scaledTokens1 = netTokens1 * metadata.multiplier;
        const priceAt1 = 1.0 / scaledTokens1;

        const rawTokensX = parseFloat(buyQuoteResult.data.outAmount) / Math.pow(10, metadata.decimals);
        const netTokensX = feeDeductedBeyondQuote ? rawTokensX * (1 - activeFeePct) : rawTokensX;
        const scaledTokensX = netTokensX * metadata.multiplier;
        const priceAtX = legUsdc / scaledTokensX;

        // Size impact = ((priceAtX - priceAt1) / priceAt1) * 100
        empiricalPriceImpactPct = Math.max(0, ((priceAtX - priceAt1) / priceAt1) * 100);
      }

      // 4. Sell-back quote for round-trip exit cost
      let sellQuoteResult = null;
      if (buyQuoteResult.ok && buyQuoteResult.data.outAmount) {
        const sellUnits = parseInt(buyQuoteResult.data.outAmount, 10);
        sellQuoteResult = await fetchJupiterQuoteCached(
          token.contract_address,
          USDC_MINT,
          sellUnits,
          true
        );
      }

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: legUsdc,
        buyQuoteResult,
        sellQuoteResult,
        multiplier: metadata.multiplier,
        decimals: metadata.decimals,
        activeFeeBps: metadata.activeFeeBps,
        feeScheduleNote: metadata.feeScheduleNote,
        empiricalPriceImpactPct,
        routeAt1,
        routeAtX,
        quoteTimestamp,
        prestocksAgeSeconds: tokenFetchResult.dataAgeSeconds || 0
      });

      const guard = evaluateGuard(metrics, {
        maxPremiumPct: Number(maxPremium),
        maxPriceImpactPct: Number(maxPriceImpact),
        warnRoundTripLossPct: Number(warnExitLoss),
        maxDivergencePct: 10.0,
        maxQuoteAgeSeconds: 60
      });

      tokenResults.push({
        symbol: token.symbol,
        name: token.name,
        mint: token.contract_address,
        allocatedUsdc: legUsdc,
        legUsdc: legUsdc,
        hasRoute: metrics.hasRoute,
        errorCode: metrics.errorCode || null,
        error: metrics.error || null,
        markPrice: token.markPrice,
        issuerPrice: token.tokenPrice,
        executablePrice: metrics.executablePrice || null,
        premiumVsMarkPct: metrics.premiumVsMarkPct ?? null,
        priceImpactPct: metrics.priceImpactPct ?? null,
        poolImpactJupiter: metrics.poolImpactJupiter ?? null,
        empiricalImpactPct: metrics.empiricalImpactPct ?? null,
        governingPriceImpactPct: metrics.governingPriceImpactPct ?? null,
        feeNote: metrics.feeNote,
        feeScheduleNote: metrics.feeScheduleNote,
        venueStatus: metrics.venueStatus || 'VERIFIED',
        routeType: metrics.routeType || null,
        routesDiffer: metrics.routesDiffer || false,
        routeAt1,
        routeAtX,
        exitUsdc: metrics.exitUsdc ?? null,
        roundTripLossPct: metrics.roundTripLossPct ?? null,
        quoteAgeSeconds: metrics.quoteAgeSeconds ?? 0,
        markAgeSeconds: tokenFetchResult.dataAgeSeconds || 0,
        guardStatus: guard.status,
        blockedReasons: guard.blockedReasons,
        warnings: guard.warnings
      });

      // Small pacing pause between tokens (50ms) to prevent rate limit spikes
      await new Promise(r => setTimeout(r, 50));
    }

    const isBasketReady = tokenResults.every(t => t.guardStatus !== 'BLOCK');

    return NextResponse.json(
      {
        success: true,
        requestedTotalUsdc,
        totalUsdc: cappedUsdc,
        isClamped,
        clampNote,
        quoteTimestamp,
        basketReady: isBasketReady,
        feeBanner: `Token transfer fees are set by the issuer and can change (${commonFeeScheduleNote}).`,
        commonFeeScheduleNote,
        prestocksStatus: {
          isStale: tokenFetchResult.isStale,
          isRateLimited: tokenFetchResult.isRateLimited,
          dataAgeSeconds: tokenFetchResult.dataAgeSeconds || 0,
          source: tokenFetchResult.source,
          rateLimitCooldownSeconds: tokenFetchResult.rateLimitCooldownSeconds || null
        },
        tokens: tokenResults,
        isRealBuyEnabled: process.env.ENABLE_REAL_BUY?.trim() === 'true'
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=20'
        }
      }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch basket quotes' },
      { status: 500 }
    );
  }
}
