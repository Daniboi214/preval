import { NextResponse } from 'next/server';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import {
  ALLOWED_SYMBOLS,
  USDC_MINT,
  DEFAULT_RPC_URL,
  PRESTOCKS_API_URL,
  fetchPreStocksTokensWithFallback,
  getLastDryRunFallback,
  saveLastDryRun,
  fetchMintMetadata,
  fetchJupiterQuoteCached,
  calculateTokenMetrics,
  evaluateGuard,
  calculateBasketAllocations,
  classifyVenue,
  validateTransactionSanity,
  calculateMinimumReceived,
  calculateRouteSlippageBps,
  getClientIpFromHeaders
} from '@/src/dataLayer.js';

function getRpcUrl(): string {
  const envRpc = process.env.SOLANA_RPC_URL?.trim();
  if (envRpc && !envRpc.includes('PASTE_YOUR_KEY_HERE')) {
    return envRpc;
  }
  return DEFAULT_RPC_URL;
}

// In-memory per-IP rate limiter: 3 requests per minute
const simulateRateLimitMap = new Map<string, { count: number; resetTime: number }>();
const SIMULATE_RATE_LIMIT = 3;
const SIMULATE_RATE_WINDOW_MS = 60000;

function checkSimulateRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = simulateRateLimitMap.get(ip);
  if (!entry || now > entry.resetTime) {
    simulateRateLimitMap.set(ip, { count: 1, resetTime: now + SIMULATE_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SIMULATE_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

// In-memory 30-second cache for identical simulation requests
const simulateCache = new Map<string, { data: any; timestamp: number }>();
const SIMULATE_CACHE_TTL_MS = 30000;

const SPL_ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

function getAta(mint: PublicKey, owner: PublicKey, programId: PublicKey = TOKEN_2022_PROGRAM_ID): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    SPL_ATA_PROGRAM_ID
  );
  return address;
}

async function simulateLegWithTimeout(
  sym: string,
  legAmount: number,
  tokenCatalog: any[],
  connection: Connection,
  simAddress: string,
  userPubkey: PublicKey,
  tokenFetchResult: any
): Promise<any> {
  const timeoutMs = 8000;
  let timer: NodeJS.Timeout;
  const timeoutPromise = new Promise<any>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Leg simulation timed out after 8s')), timeoutMs);
  });

  const workPromise = (async () => {
    const token = tokenCatalog.find((t: any) => t.symbol === sym);
    if (!token) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Token '${sym}' not found in catalog`
      };
    }

    const metadata = await fetchMintMetadata(connection, token.contract_address);

    // Gate multiplier !== 1.0 tokens until on-chain scaling verified
    if (metadata.multiplier !== 1.0) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Token '${sym}' has Token-2022 multiplier ${metadata.multiplier}x. Live/dry-run swaps restricted to 1.0x tokens.`
      };
    }

    const legAmountMicro = Math.round(legAmount * 1e6);
    // Route pinning: fetch Jupiter quote pinned to verified DEXes with onlyDirectRoutes=true
    const buyQuoteRes = await fetchJupiterQuoteCached(USDC_MINT, token.contract_address, legAmountMicro, true, 50);

    if (!buyQuoteRes.ok || !buyQuoteRes.data) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Failed to fetch route quote: ${buyQuoteRes.error || 'No verified route'}`
      };
    }

    let buyQuote = buyQuoteRes.data;

    // Multi-hop check: block if routePlan has > 1 hop
    if (buyQuote.routePlan && buyQuote.routePlan.length > 1) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Multi-hop routes (${buyQuote.routePlan.length} hops) are blocked to prevent unverified intermediate transfer fees and cumulative slippage`
      };
    }

    const venueInfo = classifyVenue(buyQuote);
    const feeDeductedBeyondQuote = venueInfo.verified && venueInfo.venue === 'Manifest';

    // Live-prepare guard parity: Require venue to be verified (Meteora DLMM, Raydium CLMM, Manifest)
    if (venueInfo.verified === false) {
      return {
        symbol: sym,
        name: token.name,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Trading venue '${venueInfo.badge || 'Unknown'}' is unverified for Token-2022 transfer fee deduction. Only Meteora DLMM, Raydium CLMM, and Manifest are permitted.`,
        venue: venueInfo.venue,
        routeType: venueInfo.badge,
        executablePrice: Number(buyQuote.outAmount) ? legAmount / ((Number(buyQuote.outAmount) / 10**metadata.decimals) * metadata.multiplier) : null,
        markPrice: token.markPrice,
        premiumPct: null
      };
    }

    // Dynamic slippage rule: Manifest = activeFeeBps + 30 (130 bps), fee-in-quote = 50 bps, capped at 150
    const slippageDecision = calculateRouteSlippageBps({
      feeDeductedBeyondQuote,
      activeFeeBps: metadata.activeFeeBps || 100
    });

    if (slippageDecision.exceedsCap) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: slippageDecision.error
      };
    }

    if (feeDeductedBeyondQuote && slippageDecision.slippageBps !== 50) {
      const reQuoteRes = await fetchJupiterQuoteCached(USDC_MINT, token.contract_address, legAmountMicro, true, slippageDecision.slippageBps);
      if (reQuoteRes.ok && reQuoteRes.data) {
        buyQuote = reQuoteRes.data;
      }
    }

    // Empirical impact quote ($1)
    const oneDollarQuoteResult = await fetchJupiterQuoteCached(
      USDC_MINT,
      token.contract_address,
      1000000,
      true
    );

    const routeAtX = buyQuote?.routePlan?.[0]?.swapInfo?.label || 'Direct';
    const routeAt1 = oneDollarQuoteResult.ok
      ? oneDollarQuoteResult.data?.routePlan?.[0]?.swapInfo?.label || 'Direct'
      : '';

    const activeFeePct = (metadata.activeFeeBps || 100) / 10000;
    let empiricalPriceImpactPct = 0;
    if (buyQuote && oneDollarQuoteResult.ok && oneDollarQuoteResult.data?.outAmount) {
      const rawTokens1 = parseFloat(oneDollarQuoteResult.data.outAmount) / Math.pow(10, metadata.decimals);
      const netTokens1 = feeDeductedBeyondQuote ? rawTokens1 * (1 - activeFeePct) : rawTokens1;
      const scaledTokens1 = netTokens1 * metadata.multiplier;
      const priceAt1 = 1.0 / scaledTokens1;

      const rawTokensX = parseFloat(buyQuote.outAmount) / Math.pow(10, metadata.decimals);
      const netTokensX = feeDeductedBeyondQuote ? rawTokensX * (1 - activeFeePct) : rawTokensX;
      const scaledTokensX = netTokensX * metadata.multiplier;
      const priceAtX = legAmount / scaledTokensX;

      empiricalPriceImpactPct = Math.max(0, ((priceAtX - priceAt1) / priceAt1) * 100);
    }

    // Real sell-back quote for round-trip exit cost
    let sellQuoteResult = null;
    if (buyQuote && buyQuote.outAmount) {
      const sellUnits = parseInt(buyQuote.outAmount, 10);
      sellQuoteResult = await fetchJupiterQuoteCached(
        token.contract_address,
        USDC_MINT,
        sellUnits,
        true
      );
    }

    const metrics = calculateTokenMetrics({
      token,
      buyAmountUsdc: legAmount,
      buyQuoteResult: { ok: true, data: buyQuote },
      sellQuoteResult,
      multiplier: metadata.multiplier,
      decimals: metadata.decimals,
      activeFeeBps: metadata.activeFeeBps || 100,
      feeScheduleNote: metadata.feeScheduleNote,
      empiricalPriceImpactPct,
      routeAt1,
      routeAtX,
      quoteTimestamp: Date.now(),
      prestocksAgeSeconds: tokenFetchResult.dataAgeSeconds || 0
    });

    const guard = evaluateGuard(metrics, {
      maxPremiumPct: 5.0,
      maxPriceImpactPct: 2.0,
      warnRoundTripLossPct: 3.0,
      maxDivergencePct: 10.0,
      maxQuoteAgeSeconds: 60
    });

    if (guard.status === 'BLOCK') {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        guardStatus: 'BLOCK',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Safety guard blocked: ${guard.blockedReasons.join('; ')}`,
        venue: venueInfo.venue,
        executablePrice: metrics.executablePrice,
        markPrice: token.markPrice,
        premiumPct: metrics.premiumVsMarkPct
      };
    }

    // Calculate minimum received matching real transaction minimum
    const minReceived = calculateMinimumReceived({
      quotedRawUnitsOut: buyQuote.outAmount,
      otherAmountThreshold: buyQuote.otherAmountThreshold,
      slippageBps: slippageDecision.slippageBps,
      activeFeeBps: metadata.activeFeeBps || 100,
      feeDeductedBeyondQuote,
      decimals: metadata.decimals,
      multiplier: metadata.multiplier
    });

    let swapData: any = null;
    try {
      const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: buyQuote,
          userPublicKey: simAddress,
          wrapAndUnwrapSol: false,
          dynamicComputeUnitLimit: true
        })
      });
      if (!swapRes.ok) {
        throw new Error(`Jupiter swap API returned HTTP ${swapRes.status}`);
      }
      swapData = await swapRes.json();
    } catch (swapErr: any) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Swap preparation failed: ${swapErr.message}`
      };
    }

    const txBuffer = Buffer.from(swapData.swapTransaction, 'base64');
    const txSizeBytes = txBuffer.length;

    const sanity = await validateTransactionSanity(swapData.swapTransaction, simAddress, legAmount, {
      connection,
      skipSim: true
    });

    if (!sanity.valid) {
      return {
        symbol: sym,
        allocationUsdc: legAmount,
        status: 'FAIL',
        txSizeBytes,
        simulatedTokensOut: 'n/a',
        netTokensDelivered: 'n/a',
        err: `Transaction sanity check failed: ${sanity.error}`
      };
    }

    // Fetch pre-simulation account state with getAccountInfo
    const tokenMint = new PublicKey(token.contract_address);
    const userPreAta = getAta(tokenMint, userPubkey, TOKEN_2022_PROGRAM_ID);
    let preTokensRaw = BigInt(0);
    try {
      const preAccount = await connection.getAccountInfo(userPreAta);
      if (preAccount?.data && preAccount.data.length >= 72) {
        preTokensRaw = preAccount.data.readBigUInt64LE(64);
      }
    } catch {
      preTokensRaw = BigInt(0);
    }

    // Run on-chain simulation with accounts introspection
    let simErr: any = null;
    let computeUnits = 0;
    let postTokensRaw = preTokensRaw;

    try {
      const tx = VersionedTransaction.deserialize(txBuffer);
      const simRes = await connection.simulateTransaction(tx, {
        accounts: { encoding: 'base64', addresses: [userPreAta.toBase58()] },
        replaceRecentBlockhash: true
      });

      if (simRes.value?.err) {
        simErr = simRes.value.err;
      } else if (simRes.value?.accounts?.[0]?.data?.[0]) {
        const postBuf = Buffer.from(simRes.value.accounts[0].data[0], 'base64');
        if (postBuf.length >= 72) {
          postTokensRaw = postBuf.readBigUInt64LE(64);
        }
      }
      computeUnits = simRes.value?.unitsConsumed || 0;
    } catch (simEx: any) {
      simErr = simEx.message;
    }

    const isPass = simErr === null;
    let simulatedTokensOut: string | number = 'n/a';
    if (isPass) {
      const rawDelivered = Number(postTokensRaw - preTokensRaw);
      const delivered = (rawDelivered / Math.pow(10, metadata.decimals || 9)) * (metadata.multiplier || 1.0);
      simulatedTokensOut = Number(delivered.toFixed(6));
    }

    return {
      symbol: sym,
      name: token.name,
      allocationUsdc: legAmount,
      status: isPass ? (guard.status === 'WARN' ? 'WARN' : 'PASS') : 'FAIL',
      guardStatus: guard.status,
      warnings: guard.warnings || [],
      simulatedTokensOut,
      netTokensDelivered: simulatedTokensOut,
      minReceivedTokens: minReceived.minScaledTokens,
      computeUnits,
      txSizeBytes,
      err: simErr ? (typeof simErr === 'object' ? JSON.stringify(simErr) : String(simErr)) : null,
      venue: venueInfo.venue,
      routeType: venueInfo.badge,
      executablePrice: metrics.executablePrice,
      markPrice: token.markPrice,
      markAgeSeconds: tokenFetchResult.dataAgeSeconds || 0,
      premiumPct: metrics.premiumVsMarkPct
    };
  })();

  try {
    const result = await Promise.race([workPromise, timeoutPromise]);
    clearTimeout(timer!);
    return result;
  } catch (err: any) {
    clearTimeout(timer!);
    return {
      symbol: sym,
      allocationUsdc: legAmount,
      status: 'FAIL',
      guardStatus: 'BLOCK',
      simulatedTokensOut: 'n/a',
      netTokensDelivered: 'n/a',
      err: err.message || 'Leg simulation failed'
    };
  }
}

export async function POST(req: Request) {
  try {
    // 0. Per-IP Rate Limit: 3 requests per minute
    const clientIp = getClientIpFromHeaders(req.headers);
    if (!checkSimulateRateLimit(clientIp)) {
      const fallback = getLastDryRunFallback();
      if (fallback) {
        return NextResponse.json(fallback);
      }
      return NextResponse.json(
        { error: 'Rate limit exceeded: maximum 3 basket simulations per minute' },
        { status: 429 }
      );
    }

    // 1. DEMO_SIM_ADDRESS: Must NOT take an address from the browser. Read ONLY from env.
    const simAddress = process.env.DEMO_SIM_ADDRESS?.trim();
    if (!simAddress) {
      const fallback = getLastDryRunFallback();
      if (fallback) {
        return NextResponse.json(fallback);
      }
      return NextResponse.json(
        { error: 'dry run needs DEMO_SIM_ADDRESS' },
        { status: 400 }
      );
    }

    const rawBody = await req.json();
    const {
      symbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'],
      totalUsdc = 0.30
    } = rawBody || {};

    // 2. Cap the legs: between 2 and 3 tokens
    if (!Array.isArray(symbols) || symbols.length < 2 || symbols.length > 3) {
      return NextResponse.json(
        { error: `Basket simulation requires between 2 and 3 tokens (provided: ${Array.isArray(symbols) ? symbols.length : 0})` },
        { status: 400 }
      );
    }

    const upperSymbols = symbols.map((s: any) => String(s || '').toUpperCase().trim());
    const uniqueSymbols = [...new Set(upperSymbols)];
    if (uniqueSymbols.length !== upperSymbols.length) {
      return NextResponse.json({ error: 'Duplicate tokens are not permitted in a basket' }, { status: 400 });
    }

    for (const sym of upperSymbols) {
      if (!ALLOWED_SYMBOLS.includes(sym)) {
        return NextResponse.json({ error: `Invalid or unapproved token symbol '${sym}'` }, { status: 400 });
      }
    }

    // 3. Validate and Cap Spend Amount: between $0.20 and $3.00 total, min $0.10/leg
    const parsedTotalUsdc = Number(totalUsdc) || 0;
    if (parsedTotalUsdc <= 0 || parsedTotalUsdc > 3.0) {
      return NextResponse.json(
        { error: `Total amount must be between $0.20 and $3.00 (requested: $${parsedTotalUsdc.toFixed(2)})` },
        { status: 400 }
      );
    }

    const allocations = calculateBasketAllocations(parsedTotalUsdc, upperSymbols);
    for (const sym of upperSymbols) {
      if ((allocations[sym] || 0) < 0.10) {
        return NextResponse.json(
          { error: `Allocation for leg ${sym} ($${(allocations[sym] || 0).toFixed(2)}) is below the $0.10 minimum` },
          { status: 400 }
        );
      }
    }

    // 4. Check 30-second identical request cache
    const cacheKey = `${upperSymbols.slice().sort().join(',')}_${parsedTotalUsdc.toFixed(2)}`;
    const now = Date.now();
    const cached = simulateCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < SIMULATE_CACHE_TTL_MS) {
      return NextResponse.json(cached.data);
    }

    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');
    const userPubkey = new PublicKey(simAddress);

    // 5. Process and simulate each leg with fresh 60s token catalog
    const tokenFetchResult = await fetchPreStocksTokensWithFallback(PRESTOCKS_API_URL, 60000);
    const isSnapshotSourced = tokenFetchResult.source === 'snapshot' || tokenFetchResult.source?.includes('snapshot');
    if (tokenFetchResult.isStale || (tokenFetchResult.dataAgeSeconds && tokenFetchResult.dataAgeSeconds > 60) || isSnapshotSourced) {
      const fallback = getLastDryRunFallback();
      if (fallback) {
        return NextResponse.json(fallback);
      }
      return NextResponse.json({ error: 'PreStocks mark price data is stale' }, { status: 400 });
    }

    const tokenCatalog = tokenFetchResult.tokens || [];
    const legResults = await Promise.all(
      upperSymbols.map((sym: string) =>
        simulateLegWithTimeout(
          sym,
          allocations[sym],
          tokenCatalog,
          connection,
          simAddress,
          userPubkey,
          tokenFetchResult
        )
      )
    );
    const hasFailures = legResults.some((l: any) => l.status === 'FAIL');

    const responsePayload = {
      success: true,
      dryRun: true,
      label: 'Dry run: simulated on mainnet, nothing was sent',
      totalUsdc: parsedTotalUsdc,
      hasFailures,
      legs: legResults
    };

    // Store last successful live dry run
    if (!hasFailures) {
      saveLastDryRun({
        timestamp: new Date().toISOString(),
        success: true,
        dryRun: true,
        totalUsdc: parsedTotalUsdc,
        legs: legResults
      });
    }

    simulateCache.set(cacheKey, { data: responsePayload, timestamp: Date.now() });

    return NextResponse.json(responsePayload);
  } catch (err: any) {
    const fallback = getLastDryRunFallback();
    if (fallback) {
      return NextResponse.json(fallback);
    }
    return NextResponse.json(
      { error: err.message || 'Basket simulation failed' },
      { status: 500 }
    );
  }
}
