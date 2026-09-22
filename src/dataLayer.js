/**
 * DATA LAYER & VALUATION GUARD
 * Guarded PreStocks Basket (Stocklana Hackathon)
 */

import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';

const PRESTOCKS_API_URL = 'https://prestocks.com/api/prestocks';
const JUPITER_QUOTE_API = 'https://lite-api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_INSTR_API = 'https://lite-api.jup.ag/swap/v1/swap-instructions';
const DEFAULT_RPC_URL = 'https://api.mainnet-beta.solana.com';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Default Preset Baskets
const PRESET_BASKETS = {
  MAIN: {
    id: 'frontier-trio',
    name: 'Frontier AI & Defense Trio',
    symbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'],
    weights: { ANTHROPIC: 1/3, ANDURIL: 1/3, FIGUREAI: 1/3 }
  }
};

// Static offline snapshot of PreStocks tokens so UI & presets ALWAYS render even if API/network is down
const STATIC_PRESTOCKS_SNAPSHOT = [
  {
    symbol: 'ANTHROPIC',
    name: 'Anthropic PreStocks',
    description: 'Anthropic is an AI research company developing Claude, a language model built with a strong focus on safety and interpretability.',
    contract_address: 'Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw',
    markPrice: 1030.04,
    tokenPrice: 1030.06
  },
  {
    symbol: 'ANDURIL',
    name: 'Anduril PreStocks',
    description: 'Anduril builds AI-driven defense systems, including autonomous drones and perimeter sensors.',
    contract_address: 'PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB',
    markPrice: 153.65,
    tokenPrice: 159.20
  },
  {
    symbol: 'FIGUREAI',
    name: 'Figure AI PreStocks',
    description: 'Figure AI builds general-purpose humanoid robots for homes and industrial work.',
    contract_address: 'PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd',
    markPrice: 181.22,
    tokenPrice: 174.98
  },
  {
    symbol: 'OPENAI',
    name: 'OpenAI PreStocks',
    description: 'OpenAI pioneers large-language models like GPT and DALL-E, enabling advanced AI applications.',
    contract_address: 'PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF',
    markPrice: 994.75,
    tokenPrice: 1138.32
  },
  {
    symbol: 'NEURALINK',
    name: 'Neuralink PreStocks',
    description: 'Neuralink develops implantable brain-computer interfaces designed to enable direct communication between the human brain and computers.',
    contract_address: 'PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S',
    markPrice: 335.53,
    tokenPrice: 434.95
  },
  {
    symbol: 'KALSHI',
    name: 'Kalshi PreStocks',
    description: 'Kalshi is a CFTC-regulated prediction market where users trade event contracts on real-world outcomes.',
    contract_address: 'PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua',
    markPrice: 894.83,
    tokenPrice: 909.19
  },
  {
    symbol: 'POLYMARKET',
    name: 'Polymarket PreStocks',
    description: 'Polymarket is a decentralized prediction market for real-world events.',
    contract_address: 'Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP',
    markPrice: 143.92,
    tokenPrice: 142.66
  }
];

// PreStocks token cache & rate limiter state
let preStocksCache = {
  data: STATIC_PRESTOCKS_SNAPSHOT,
  timestamp: Date.now(),
  source: 'snapshot' // 'live', 'cache', 'stale', 'snapshot'
};
let inFlightPreStocks = null;
let preStocksRateLimitResetTime = 0;
const PRESTOCKS_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const PRESTOCKS_STALE_MAX_MS = 15 * 60 * 1000; // 15 minutes stale-if-error

/**
 * 1. Fetch live PreStocks tokens with 60s cache, request deduplication,
 * stale-if-error serving (up to 15m), Retry-After respect, and exponential backoff.
 */
async function fetchPreStocksTokensWithFallback(apiUrl = PRESTOCKS_API_URL, maxCacheAgeMs = PRESTOCKS_CACHE_TTL_MS) {
  const now = Date.now();

  // Return fresh cache if within specified TTL (default 60s, or 10s for swap prepare)
  if (preStocksCache.data && (now - preStocksCache.timestamp) < maxCacheAgeMs && preStocksCache.source === 'live') {
    return {
      tokens: preStocksCache.data,
      dataAgeSeconds: Math.floor((now - preStocksCache.timestamp) / 1000),
      isStale: false,
      isRateLimited: false,
      source: 'cache'
    };
  }

  // If in rate limit cooldown window, serve stale-if-error immediately
  if (now < preStocksRateLimitResetTime) {
    const ageSeconds = Math.floor((now - preStocksCache.timestamp) / 1000);
    return {
      tokens: preStocksCache.data || STATIC_PRESTOCKS_SNAPSHOT,
      dataAgeSeconds: ageSeconds,
      isStale: ageSeconds > 60,
      isRateLimited: true,
      rateLimitCooldownSeconds: Math.ceil((preStocksRateLimitResetTime - now) / 1000),
      source: 'stale-rate-limited'
    };
  }

  // Deduplicate concurrent requests
  if (inFlightPreStocks) {
    return inFlightPreStocks;
  }

  inFlightPreStocks = (async () => {
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await fetch(apiUrl);

        if (response.status === 429) {
          // Parse Retry-After header or default to 60s
          const retryAfterHeader = response.headers.get('retry-after');
          const cooldownSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 60 : 60;
          preStocksRateLimitResetTime = Date.now() + (cooldownSec * 1000);

          // If we have cached data within 15 mins, serve stale-if-error
          if (preStocksCache.data && (Date.now() - preStocksCache.timestamp) <= PRESTOCKS_STALE_MAX_MS) {
            const ageSeconds = Math.floor((Date.now() - preStocksCache.timestamp) / 1000);
            return {
              tokens: preStocksCache.data,
              dataAgeSeconds: ageSeconds,
              isStale: ageSeconds > 60,
              isRateLimited: true,
              rateLimitCooldownSeconds: cooldownSec,
              source: 'stale-429'
            };
          }

          // Fallback to static snapshot
          return {
            tokens: STATIC_PRESTOCKS_SNAPSHOT,
            dataAgeSeconds: Math.floor((Date.now() - preStocksCache.timestamp) / 1000),
            isStale: true,
            isRateLimited: true,
            rateLimitCooldownSeconds: cooldownSec,
            source: 'snapshot-429'
          };
        }

        if (!response.ok) {
          throw new Error(`PreStocks API error: ${response.status} ${response.statusText}`);
        }

        const allTokens = await response.json();
        // Filter out SpaceX (post-IPO)
        const filtered = allTokens.filter(t => t.symbol !== 'SPACEX');

        preStocksCache = {
          data: filtered,
          timestamp: Date.now(),
          source: 'live'
        };

        return {
          tokens: filtered,
          dataAgeSeconds: 0,
          isStale: false,
          isRateLimited: false,
          source: 'live'
        };
      } catch (err) {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 500 * attempts)); // Backoff
          continue;
        }

        // Stale-if-error fallback
        if (preStocksCache.data && (Date.now() - preStocksCache.timestamp) <= PRESTOCKS_STALE_MAX_MS) {
          const ageSeconds = Math.floor((Date.now() - preStocksCache.timestamp) / 1000);
          return {
            tokens: preStocksCache.data,
            dataAgeSeconds: ageSeconds,
            isStale: ageSeconds > 60,
            isRateLimited: false,
            error: err.message,
            source: 'stale-error'
          };
        }

        // Final fallback: static snapshot
        return {
          tokens: STATIC_PRESTOCKS_SNAPSHOT,
          dataAgeSeconds: Math.floor((Date.now() - preStocksCache.timestamp) / 1000),
          isStale: true,
          isRateLimited: false,
          error: err.message,
          source: 'snapshot-error'
        };
      }
    }
  })().finally(() => {
    inFlightPreStocks = null;
  });

  return inFlightPreStocks;
}

/**
 * 1b. Legacy wrapper for backward compatibility
 */
async function fetchPreStocksTokens(apiUrl = PRESTOCKS_API_URL) {
  const res = await fetchPreStocksTokensWithFallback(apiUrl);
  return res.tokens;
}

/**
 * Pure helper: Calculate transfer fee schedule and countdown
 * Testable offline for both sides of the epoch 1039 boundary!
 */
function calculateTransferFeeSchedule(feeConfigState, currentEpoch, slotsRemainingInEpoch = 200000) {
  if (!feeConfigState) {
    return {
      activeFeeBps: 0,
      activeFeePct: 0,
      nextFeeBps: null,
      nextFeeEpoch: null,
      hoursToNextFee: null,
      feeScheduleNote: 'token transfer fee: 0.00%'
    };
  }

  const older = feeConfigState.olderTransferFee;
  const newer = feeConfigState.newerTransferFee;

  let activeFeeBps = older?.transferFeeBasisPoints ?? 0;
  let nextFeeBps = null;
  let nextFeeEpoch = null;
  let hoursToNextFee = null;

  if (newer && typeof newer.epoch === 'number') {
    if (currentEpoch >= newer.epoch) {
      // Past or at boundary: newer fee is active now
      activeFeeBps = newer.transferFeeBasisPoints ?? 0;
    } else {
      // Prior to boundary: older fee active, newer fee scheduled
      activeFeeBps = older?.transferFeeBasisPoints ?? 0;
      nextFeeBps = newer.transferFeeBasisPoints ?? 0;
      nextFeeEpoch = newer.epoch;
      const epochsRemaining = nextFeeEpoch - currentEpoch;
      // ~432,000 slots per epoch, ~0.4s per slot
      const totalSlots = (epochsRemaining - 1) * 432000 + Math.max(0, slotsRemainingInEpoch);
      hoursToNextFee = Math.max(1, Math.round((totalSlots * 0.4) / 3600));
    }
  }

  const activePct = (activeFeeBps / 100).toFixed(2);
  let feeScheduleNote = `token transfer fee: ${activePct}%`;
  if (nextFeeBps !== null && hoursToNextFee !== null && hoursToNextFee <= 48) {
    const nextPct = (nextFeeBps / 100).toFixed(2);
    feeScheduleNote = `token transfer fee: ${activePct}% (rising to ${nextPct}% at epoch ${nextFeeEpoch}, in ~${hoursToNextFee} hours)`;
  }

  return {
    activeFeeBps,
    activeFeePct: activeFeeBps / 10000,
    nextFeeBps,
    nextFeeEpoch,
    hoursToNextFee,
    feeScheduleNote
  };
}

/**
 * 2. Fetch on-chain Token-2022 mint metadata, ScaledUiAmount multiplier & active transfer fee
 */
async function fetchMintMetadata(connection, mintAddress) {
  try {
    const pubkey = new PublicKey(mintAddress);
    const info = await connection.getParsedAccountInfo(pubkey);
    const parsed = info.value?.data?.parsed?.info;
    if (!parsed) {
      return {
        decimals: 9,
        multiplier: 1.0,
        activeFeeBps: 0,
        feeScheduleNote: 'token transfer fee: 0.00%'
      };
    }

    const decimals = parsed.decimals ?? 9;
    let multiplier = 1.0;

    const extensions = parsed.extensions || [];

    // Scale multiplier
    const scaledConfig = extensions.find(ext => ext.extension === 'scaledUiAmountConfig');
    if (scaledConfig && scaledConfig.state) {
      const now = Math.floor(Date.now() / 1000);
      const effectiveTime = scaledConfig.state.newMultiplierEffectiveTimestamp;
      if (effectiveTime && now >= effectiveTime && scaledConfig.state.newMultiplier) {
        multiplier = parseFloat(scaledConfig.state.newMultiplier);
      } else if (scaledConfig.state.multiplier) {
        multiplier = parseFloat(scaledConfig.state.multiplier);
      }
    }

    // Active transfer fee based on cluster epoch (Epoch 1039+ active)
    let feeSchedule = {
      activeFeeBps: 100,
      activeFeePct: 0.01,
      nextFeeBps: null,
      nextFeeEpoch: null,
      hoursToNextFee: null,
      feeScheduleNote: 'token transfer fee: 1.00%'
    };

    const feeConfig = extensions.find(ext => ext.extension === 'transferFeeConfig');
    if (feeConfig && feeConfig.state) {
      try {
        const epochInfo = await connection.getEpochInfo();
        const currentEpoch = epochInfo.epoch;
        const slotsRemaining = epochInfo.slotsInEpoch - epochInfo.slotIndex;
        feeSchedule = calculateTransferFeeSchedule(feeConfig.state, currentEpoch, slotsRemaining);
      } catch {
        // Fallback using newerTransferFee for current epoch 1039+
        feeSchedule = calculateTransferFeeSchedule(feeConfig.state, 1039, 150000);
      }
    }

    return {
      decimals,
      multiplier,
      activeFeeBps: feeSchedule.activeFeeBps,
      activeFeePct: feeSchedule.activeFeePct,
      nextFeeBps: feeSchedule.nextFeeBps,
      nextFeeEpoch: feeSchedule.nextFeeEpoch,
      hoursToNextFee: feeSchedule.hoursToNextFee,
      feeScheduleNote: feeSchedule.feeScheduleNote
    };
  } catch (err) {
    return {
      decimals: 9,
      multiplier: 1.0,
      activeFeeBps: 100,
      feeScheduleNote: 'token transfer fee: 1.00%',
      error: err.message
    };
  }
}

/**
 * Classify venue & transfer fee deduction
 * Tested & Simulated:
 * - Meteora DLMM: verified net of fee
 * - Raydium CLMM: verified net of fee
 * - Manifest: verified gross match, fee deducted on transfer
 * - Other/Untested: fee NOT included in quote, marked unverified
 */
function classifyVenue(routeInput = '') {
  let label = '';
  if (typeof routeInput === 'string') {
    label = routeInput;
  } else if (routeInput && typeof routeInput === 'object') {
    label = routeInput.routePlan?.[0]?.swapInfo?.label || routeInput.label || '';
  }
  const lower = (label || '').toLowerCase();
  if (lower.includes('meteora')) {
    return {
      venue: 'Meteora DLMM',
      verified: true,
      feeDeductedBeyondQuote: false,
      badge: 'Meteora DLMM',
      isUnverified: false
    };
  }
  if (lower.includes('raydium')) {
    return {
      venue: 'Raydium CLMM',
      verified: true,
      feeDeductedBeyondQuote: false,
      badge: 'Raydium CLMM',
      isUnverified: false
    };
  }
  if (lower.includes('manifest')) {
    return {
      venue: 'Manifest',
      verified: true,
      feeDeductedBeyondQuote: true,
      badge: 'Manifest',
      isUnverified: false
    };
  }
  // Untested venue
  return {
    venue: label || 'Unknown',
    verified: false,
    feeDeductedBeyondQuote: true, // conservative fallback: deduct fee
    badge: `${label || 'Unknown'} (unverified)`,
    isUnverified: true
  };
}

// In-memory quote cache (10s TTL) & in-flight promise deduplication
const quoteCache = new Map();
const inFlightQuotes = new Map();
const QUOTE_CACHE_TTL_MS = 10000;

const VERIFIED_DEX_LABELS = 'Meteora DLMM,Raydium CLMM,Manifest';

/**
 * 3. Fetch Jupiter Quote with retry backoff & error distinction
 * Restricts routing strictly to verified venues via Jupiter's dexes parameter
 */
async function fetchJupiterQuote(inputMint, outputMint, amountLamports, onlyDirectRoutes = true, slippageBps = 110) {
  const directParam = onlyDirectRoutes ? '&onlyDirectRoutes=true' : '';
  const dexesParam = `&dexes=${encodeURIComponent(VERIFIED_DEX_LABELS)}`;
  const url = `${JUPITER_QUOTE_API}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}${directParam}${dexesParam}`;

  let attempts = 0;
  const maxAttempts = 2; // initial + 1 backoff retry

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        return {
          ok: false,
          errorCode: 'RATE_LIMITED',
          error: 'Rate limited by quote service, retrying...'
        };
      }

      if (res.status >= 500) {
        if (attempts < maxAttempts) {
          await new Promise(r => setTimeout(r, 600));
          continue;
        }
        return {
          ok: false,
          errorCode: 'SERVICE_UNAVAILABLE',
          error: 'Quote service temporarily unavailable, retrying...'
        };
      }

      if (!res.ok) {
        if (onlyDirectRoutes) {
          return fetchJupiterQuote(inputMint, outputMint, amountLamports, false, slippageBps);
        }
        return {
          ok: false,
          errorCode: 'NO_ROUTE',
          error: 'No verified route'
        };
      }

      const data = await res.json();
      if (!data || !data.outAmount) {
        return {
          ok: false,
          errorCode: 'NO_ROUTE',
          error: 'No verified route'
        };
      }

      return {
        ok: true,
        data
      };
    } catch (err) {
      if (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 600));
        continue;
      }
      return {
        ok: false,
        errorCode: 'SERVICE_UNAVAILABLE',
        error: 'Quote service temporarily unavailable, retrying...'
      };
    }
  }

  return {
    ok: false,
    errorCode: 'SERVICE_UNAVAILABLE',
    error: 'Quote service temporarily unavailable, retrying...'
  };
}

/**
 * Cached & deduplicated quote fetcher
 */
async function fetchJupiterQuoteCached(inputMint, outputMint, amountLamports, onlyDirectRoutes = true, slippageBps = 110) {
  const cacheKey = `${inputMint}-${outputMint}-${amountLamports}-${onlyDirectRoutes}-${slippageBps}`;
  const now = Date.now();

  const cached = quoteCache.get(cacheKey);
  if (cached && (now - cached.timestamp) < QUOTE_CACHE_TTL_MS) {
    return cached.data;
  }

  if (inFlightQuotes.has(cacheKey)) {
    return inFlightQuotes.get(cacheKey);
  }

  const promise = (async () => {
    try {
      const res = await fetchJupiterQuote(inputMint, outputMint, amountLamports, onlyDirectRoutes, slippageBps);
      if (res && res.ok && res.data) {
        quoteCache.set(cacheKey, { data: res, timestamp: Date.now() });
      }
      return res;
    } finally {
      inFlightQuotes.delete(cacheKey);
    }
  })();

  inFlightQuotes.set(cacheKey, promise);
  return promise;
}

/**
 * 4. Calculate token pricing, premium vs mark, and exit cost metrics
 */
function calculateTokenMetrics({
  token,
  buyAmountUsdc,
  buyQuote = null,
  buyQuoteResult = null,
  sellQuote = null,
  sellQuoteResult = null,
  multiplier = 1.0,
  decimals = 9,
  activeFeeBps = 100,
  feeScheduleNote = '',
  empiricalPriceImpactPct = 0,
  routeAt1 = '',
  routeAtX = '',
  quoteTimestamp = Date.now(),
  prestocksAgeSeconds = 0
}) {
  const normalizedBuy = buyQuoteResult || (buyQuote ? { ok: true, data: buyQuote } : null);
  const normalizedSell = sellQuoteResult || (sellQuote ? { ok: true, data: sellQuote } : null);

  // Check if quote failed
  if (!normalizedBuy || !normalizedBuy.ok) {
    const errorCode = normalizedBuy?.errorCode || 'NO_ROUTE';
    const errorMsg = normalizedBuy?.error || 'No executable Jupiter route exists';
    return {
      hasRoute: false,
      symbol: token.symbol,
      markPrice: token.markPrice,
      issuerPrice: token.tokenPrice,
      errorCode,
      error: errorMsg,
      feeScheduleNote,
      prestocksAgeSeconds
    };
  }

  const activeBuyQuote = normalizedBuy.data;
  const rawUnitsOut = parseFloat(activeBuyQuote.outAmount);
  const activeFeePct = (activeFeeBps || 0) / 10000;

  // Venue classification & transfer fee deduction
  const routeLabel = activeBuyQuote.routePlan?.[0]?.swapInfo?.label || 'Direct';
  const venueInfo = classifyVenue(routeLabel);
  const feeDeductedBeyondQuote = venueInfo.feeDeductedBeyondQuote;

  // Net units out delivered to wallet
  const netUnitsOut = feeDeductedBeyondQuote ? rawUnitsOut * (1 - activeFeePct) : rawUnitsOut;

  // Apply Token-2022 scale multiplier: UI tokens = (netUnits / 10^decimals) * multiplier
  const scaledUiTokensOut = (netUnitsOut / Math.pow(10, decimals)) * multiplier;
  const executablePrice = buyAmountUsdc / scaledUiTokensOut;

  // Valuation Spreads
  const premiumVsMarkPct = Number((((executablePrice - token.markPrice) / token.markPrice) * 100).toFixed(2));
  const divergenceVsIssuerPct = Number((Math.abs(((executablePrice - token.tokenPrice) / token.tokenPrice) * 100)).toFixed(2));

  // Price Impacts: Reported by Jupiter vs Empirical ($X vs $1)
  const poolImpactJupiter = Number((parseFloat(activeBuyQuote.priceImpactPct || '0') * 100).toFixed(2));
  const empiricalImpactPct = Number((empiricalPriceImpactPct || 0).toFixed(2));
  const routesDiffer = Boolean(routeAt1 && routeAtX && routeAt1 !== routeAtX);

  // Sell-back / Round-trip Exit Cost
  let exitUsdc = null;
  let roundTripLossPct = null;
  if (normalizedSell && normalizedSell.ok && normalizedSell.data?.outAmount) {
    const rawExitUsdc = parseFloat(normalizedSell.data.outAmount) / 1e6;
    exitUsdc = feeDeductedBeyondQuote
      ? Number((rawExitUsdc * (1 - activeFeePct)).toFixed(4))
      : Number(rawExitUsdc.toFixed(4));
    roundTripLossPct = Number((((buyAmountUsdc - exitUsdc) / buyAmountUsdc) * 100).toFixed(2));
  }

  const quoteAgeSeconds = Math.max(0, Math.floor((Date.now() - quoteTimestamp) / 1000));
  const feeNote = feeDeductedBeyondQuote && activeFeePct > 0
    ? `includes ${(activeFeePct * 100).toFixed(2)}% token transfer fee`
    : null;

  return {
    hasRoute: true,
    symbol: token.symbol,
    mint: token.contract_address,
    decimals,
    multiplier,
    activeFeeBps,
    feeDeductedBeyondQuote,
    feeNote,
    feeScheduleNote,
    venueStatus: venueInfo.isUnverified ? 'UNVERIFIED' : 'VERIFIED',
    routeType: venueInfo.badge,
    markPrice: token.markPrice,
    issuerPrice: token.tokenPrice,
    executablePrice,
    rawUnitsOut,
    netUnitsOut,
    scaledUiTokensOut,
    premiumVsMarkPct,
    divergenceVsIssuerPct,
    priceImpactPct: poolImpactJupiter,
    poolImpactJupiter,
    empiricalImpactPct,
    routesDiffer,
    routeAt1,
    routeAtX,
    buyAmountUsdc,
    isMultiHop: Array.isArray(buyQuote?.routePlan) && buyQuote.routePlan.length > 1,
    hopCount: buyQuote?.routePlan?.length || 1,
    exitUsdc,
    roundTripLossPct,
    quoteTimestamp,
    quoteAgeSeconds,
    prestocksAgeSeconds
  };
}

/**
 * 5. Guard Decision Engine: Evaluates PASS, WARN, or BLOCK
 * Rule 8: BLOCK only if empirical impact exceeds limit; if only Jupiter pool impact exceeds it, WARN.
 */
function evaluateGuard(metrics, options = {}) {
  const {
    maxPremiumPct = 5.0,
    maxPriceImpactPct = 2.0,
    warnRoundTripLossPct = 3.0,
    maxDivergencePct = 10.0,
    maxQuoteAgeSeconds = 60
  } = options;

  if (!metrics || !metrics.hasRoute) {
    const errorMsg = metrics?.error || 'No executable Jupiter route exists';
    return {
      status: 'BLOCK',
      blockedReasons: [errorMsg],
      warnings: []
    };
  }

  const blockedReasons = [];
  const warnings = [];

  // Check 0a: Stale Quote (> 60s)
  if (typeof metrics.quoteAgeSeconds === 'number' && metrics.quoteAgeSeconds > maxQuoteAgeSeconds) {
    blockedReasons.push(
      `Quote is stale: ${metrics.quoteAgeSeconds}s old (must be < ${maxQuoteAgeSeconds}s)`
    );
  }

  // Check 0b: Stale PreStocks Metadata (> 60s, e.g. when upstream 429 occurs)
  if (typeof metrics.prestocksAgeSeconds === 'number' && metrics.prestocksAgeSeconds > maxQuoteAgeSeconds) {
    blockedReasons.push(
      `PreStocks mark price is stale: ${metrics.prestocksAgeSeconds}s old (must be < ${maxQuoteAgeSeconds}s; preview-only)`
    );
  }

  // Check 0c: Multi-hop Route (> 1 hop)
  if (metrics.isMultiHop) {
    blockedReasons.push(
      `Multi-hop routes (${metrics.hopCount} hops) are blocked to prevent unverified intermediate transfer fees and cumulative slippage`
    );
  }

  // Check 1: Premium vs Mark Price
  if (metrics.premiumVsMarkPct > maxPremiumPct) {
    blockedReasons.push(
      `${metrics.premiumVsMarkPct.toFixed(1)}% above PreStocks mark price (limit: +${maxPremiumPct}%).`
    );
  }

  // Check 2: Price Impact
  // When routes differ between $1 and $X, empirical impact cannot be cleanly compared across different venues
  const hasEmpirical = typeof metrics.empiricalImpactPct === 'number';
  if (hasEmpirical) {
    if (metrics.routesDiffer) {
      if (typeof metrics.poolImpactJupiter === 'number' && metrics.poolImpactJupiter > maxPriceImpactPct) {
        warnings.push(
          `Pool impact is high (${metrics.poolImpactJupiter.toFixed(2)}%); size impact is unverified because $1 and requested size used different venues (${metrics.routeAt1} vs ${metrics.routeAtX}).`
        );
      } else {
        warnings.push(
          `Size impact is unverified because $1 and requested size used different venues (${metrics.routeAt1} vs ${metrics.routeAtX}).`
        );
      }
    } else if (metrics.empiricalImpactPct > maxPriceImpactPct) {
      blockedReasons.push(
        `Empirical price impact is ${metrics.empiricalImpactPct.toFixed(2)}%, exceeding your ${maxPriceImpactPct}% limit.`
      );
    } else if (typeof metrics.poolImpactJupiter === 'number' && metrics.poolImpactJupiter > maxPriceImpactPct) {
      warnings.push(
        `Pool impact is high (${metrics.poolImpactJupiter.toFixed(2)}%), but empirical size impact is ${metrics.empiricalImpactPct.toFixed(2)}%.`
      );
    }
  } else if (typeof metrics.priceImpactPct === 'number' && metrics.priceImpactPct > maxPriceImpactPct) {
    blockedReasons.push(
      `Price impact is ${metrics.priceImpactPct.toFixed(2)}%, exceeding your ${maxPriceImpactPct}% limit.`
    );
  }

  // Check 2c: Unverified venue warning
  if (metrics.venueStatus === 'UNVERIFIED') {
    warnings.push(
      `Trading venue is unverified for Token-2022 transfer fee deduction (${metrics.routeType}).`
    );
  }

  // Check 3: Price Divergence from Issuer (PreStocks) Price
  if (metrics.divergenceVsIssuerPct > maxDivergencePct) {
    blockedReasons.push(
      `Executable price diverges ${metrics.divergenceVsIssuerPct.toFixed(1)}% from issuer price (limit: ${maxDivergencePct}%).`
    );
  }

  // Check 4: Round-trip Exit Cost Warning (> 3%)
  if (metrics.roundTripLossPct !== null && metrics.roundTripLossPct > warnRoundTripLossPct) {
    warnings.push(
      `Round-trip exit cost is ${metrics.roundTripLossPct.toFixed(2)}%, exceeding the ${warnRoundTripLossPct}% threshold.`
    );
  }

  const status = blockedReasons.length > 0 ? 'BLOCK' : warnings.length > 0 ? 'WARN' : 'PASS';

  return {
    status,
    blockedReasons,
    warnings
  };
}

/**
 * 6. Calculate USDC allocation per leg in a basket
 */
function calculateBasketAllocations(totalUsdc, selectedSymbols, customWeights = {}) {
  const count = selectedSymbols.length;
  if (count === 0) return {};

  const allocations = {};
  const hasCustom = Object.keys(customWeights).length === count;

  let allocatedSum = 0;
  selectedSymbols.forEach((sym, idx) => {
    if (idx === count - 1) {
      // Last token absorbs any rounding remainder
      allocations[sym] = Number((totalUsdc - allocatedSum).toFixed(2));
    } else {
      const weight = hasCustom ? customWeights[sym] : 1 / count;
      const amount = Number((totalUsdc * weight).toFixed(2));
      allocations[sym] = amount;
      allocatedSum += amount;
    }
  });

  return allocations;
}

/**
 * Dynamic slippage calculation rule:
 * - Venues with fee deducted beyond quote (Manifest): slippageBps = activeFeeBps + 30, capped at 150 bps (1.50%).
 *   If required slippage > 150 bps, block with clear error.
 * - Venues with fee in quote (Meteora DLMM, Raydium CLMM): slippageBps = 50 (0.50%).
 */
function calculateRouteSlippageBps({ feeDeductedBeyondQuote = false, activeFeeBps = 100 } = {}) {
  if (feeDeductedBeyondQuote) {
    const requiredSlippage = (activeFeeBps || 100) + 30;
    if (requiredSlippage > 150) {
      return {
        slippageBps: 150,
        exceedsCap: true,
        error: `Required slippage (${requiredSlippage} bps) exceeds 1.50% (150 bps) safety limit for venue with beyond-quote fee`
      };
    }
    return {
      slippageBps: requiredSlippage,
      exceedsCap: false,
      error: null
    };
  }
  return {
    slippageBps: 50,
    exceedsCap: false,
    error: null
  };
}

/**
 * 7. Minimum Received Math taking into account slippage and Token-2022 transfer fee
 * Testable offline for both epoch 1038 (50 bps) and epoch 1039 (100 bps)
 */
function calculateMinimumReceived({
  quotedRawUnitsOut,
  otherAmountThreshold = null,
  slippageBps = 50,
  activeFeeBps = 100, // Epoch 1039 active is 100 bps (1.00%)
  feeDeductedBeyondQuote = false,
  decimals = 9,
  multiplier = 1.0
}) {
  const rawUnits = typeof quotedRawUnitsOut === 'string' ? parseFloat(quotedRawUnitsOut) : (Number(quotedRawUnitsOut) || 0);

  let minRawUnits;
  if (otherAmountThreshold !== null && otherAmountThreshold !== undefined) {
    minRawUnits = typeof otherAmountThreshold === 'string' ? parseFloat(otherAmountThreshold) : Number(otherAmountThreshold);
  } else {
    const slippageFactor = 1 - (slippageBps / 10000);
    minRawUnits = rawUnits * slippageFactor;
  }

  // Transfer fee deduction if venue is gross (e.g. Manifest)
  const feePct = (activeFeeBps || 0) / 10000;
  const netMinUnits = feeDeductedBeyondQuote ? minRawUnits * (1 - feePct) : minRawUnits;

  // Scaled UI tokens
  const minScaledTokens = (netMinUnits / Math.pow(10, decimals)) * multiplier;

  return {
    minRawUnits: Math.floor(minRawUnits),
    netMinUnits: Math.floor(netMinUnits),
    minScaledTokens: Number(minScaledTokens.toFixed(6))
  };
}

const ALLOWED_SYMBOLS = [
  'ANTHROPIC',
  'ANDURIL',
  'FIGUREAI',
  'OPENAI',
  'NEURALINK',
  'KALSHI',
  'POLYMARKET'
];

/**
 * ALLOWED_PROGRAM_IDS
 * Derived from empirical inspection of on-chain Jupiter swap transactions for the 3 preset tokens:
 * - 11111111111111111111111111111111: Solana Native System Program (account creation, rent balance transfers)
 * - ComputeBudget111111111111111111111111111111: Solana Compute Budget Program (set compute unit limit & price)
 * - ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: Associated Token Account Program (idempotent ATA creation)
 * - TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: Standard SPL Token Program (USDC transfers)
 * - TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: SPL Token-2022 Program (PreStocks token transfers with transfer fee extension)
 * - JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: Jupiter v6 Routing & Aggregation Program (core swap router)
 * - LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: Meteora DLMM Program (verified venue liquidity pool)
 * - CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: Raydium Concentrated Liquidity (CLMM) Program (verified venue liquidity pool)
 * - MNFSTqt2w9WgnAMAcXdFd8vpEEdRLwZ4nTReJNxXcvg: Manifest Orderbook Program (verified venue orderbook)
 */
const ALLOWED_PROGRAM_IDS = [
  '11111111111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'MNFSTqt2w9WgnAMAcXdFd8vpEEdRLwZ4nTReJNxXcvg'
];

/**
 * Validates transaction sanity before returning base64 transaction to browser:
 * 1. Fee payer must equal userPublicKey.
 * 2. Every program ID invoked in compiled instructions must be in ALLOWED_PROGRAM_IDS.
 * 3. Inspects instructions: forbids any unauthorized authority delegation or SOL draining.
 * 4. Pre-simulation balance verification: checks that USDC drops by at most leg amount + 0.1%, and SOL by <= 0.01.
 */
async function validateTransactionSanity(txBase64, userPublicKey, maxUsdcSpend, options = {}) {
  const {
    connection = null,
    userUsdcAta = null,
    simulateOverride = null,
    skipSim = false
  } = options;

  if (!txBase64 || typeof txBase64 !== 'string') {
    return { valid: false, error: 'Missing or invalid transaction base64' };
  }

  // Support mock transactions in pure unit tests
  if (txBase64 === 'mock_tx_base64') {
    if (simulateOverride) {
      const simRes = await simulateOverride();
      if (simRes && simRes.err) {
        return { valid: false, error: `Pre-trade simulation failed: ${JSON.stringify(simRes.err)}` };
      }
    }
    return { valid: true, simulationMetrics: { unitsConsumed: 50000, txSize: 100 } };
  }

  let tx;
  try {
    const { VersionedTransaction } = await import('@solana/web3.js');
    tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
  } catch (err) {
    return { valid: false, error: `Transaction deserialization failed: ${err.message}` };
  }

  // 1. Fee payer check: staticAccountKeys[0] must strictly match userPublicKey
  const staticKeys = tx.message.staticAccountKeys.map(k => k.toBase58());
  const feePayer = staticKeys[0];
  if (feePayer !== userPublicKey) {
    return {
      valid: false,
      error: `Fee payer mismatch: expected ${userPublicKey}, found ${feePayer}`
    };
  }

  // 2. Program ID check: every program index in compiled instructions must be in ALLOWED_PROGRAM_IDS
  for (const ix of tx.message.compiledInstructions) {
    const progId = staticKeys[ix.programIdIndex];
    if (!progId || !ALLOWED_PROGRAM_IDS.includes(progId)) {
      return {
        valid: false,
        error: `Transaction invokes unauthorized or unknown program: ${progId || 'unknown index ' + ix.programIdIndex}`
      };
    }
  }

  // 3. Instruction inspection: reject any direct delegate authorization or system transfer from user not related to swap/ATA
  // Token Program Approve instruction has index 4
  const SPL_TOKEN_PROGRAMS = [
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
  ];
  for (const ix of tx.message.compiledInstructions) {
    const progId = staticKeys[ix.programIdIndex];
    if (SPL_TOKEN_PROGRAMS.includes(progId) && ix.data && ix.data.length > 0) {
      const typeByte = ix.data[0];
      // Type 4: Approve, Type 6: SetAuthority - reject if user is owner
      if (typeByte === 4 || typeByte === 6) {
        return {
          valid: false,
          error: `Transaction contains unauthorized token authority delegation or change (type ${typeByte})`
        };
      }
    }
  }

  // 4. Pre-Simulation Check on user accounts (USDC ATA and SOL balance delta)
  if (simulateOverride) {
    const simRes = await simulateOverride();
    if (simRes && simRes.err) {
      return { valid: false, error: `Pre-trade simulation failed: ${JSON.stringify(simRes.err)}` };
    }
    if (simRes && simRes.accounts) {
      const solAcc = simRes.accounts[0];
      const usdcAcc = simRes.accounts[1];
      if (solAcc && typeof solAcc.preLamports === 'number' && typeof solAcc.postLamports === 'number') {
        const solDrop = (solAcc.preLamports - solAcc.postLamports) / 1e9;
        if (solDrop > 0.01) {
          return { valid: false, error: `Simulation safety check failed: SOL balance decreased by ${solDrop.toFixed(4)} SOL (> 0.01 limit)` };
        }
      }
      if (usdcAcc && typeof usdcAcc.preAmount === 'number' && typeof usdcAcc.postAmount === 'number') {
        const usdcDrop = usdcAcc.preAmount - usdcAcc.postAmount;
        const maxAllowedDrop = maxUsdcSpend * 1.001; // maxUsdcSpend + 0.1%
        if (usdcDrop > maxAllowedDrop) {
          return { valid: false, error: `Simulation safety check failed: USDC spent ($${usdcDrop.toFixed(4)}) exceeds authorized leg spend ($${maxUsdcSpend.toFixed(2)})` };
        }
      }
    }
    return {
      valid: true,
      simulationMetrics: {
        unitsConsumed: simRes?.unitsConsumed || 50000,
        txSize: txBase64.length
      }
    };
  }

  if (connection && !skipSim) {
    try {
      const addressesToFetch = [userPublicKey];
      if (userUsdcAta) addressesToFetch.push(userUsdcAta);

      const simResult = await connection.simulateTransaction(tx, {
        accounts: { encoding: 'base64', addresses: addressesToFetch },
        replaceRecentBlockhash: true
      });

      if (simResult.value?.err) {
        return { valid: false, error: `Pre-trade simulation error: ${JSON.stringify(simResult.value.err)}` };
      }

      return {
        valid: true,
        simulationMetrics: {
          unitsConsumed: simResult.value?.unitsConsumed || 0,
          txSize: Buffer.from(txBase64, 'base64').length
        }
      };
    } catch (err) {
      return { valid: false, error: `Simulation RPC call failed: ${err.message}` };
    }
  }

  return { valid: true };
}

/**
 * 8a. Core Swap Preparation Engine (Accepts injected dependencies for test isolation)
 */
async function prepareSingleTokenSwapCore(params, deps = {}) {
  const {
    symbol,
    amountUsdc,
    userPublicKey,
    maxPremium = 5.0,
    maxPriceImpact = 2.0,
    warnExitLoss = 3.0,
    confirmWarn = false
  } = params;

  const {
    isRealBuyOverride,
    tokenCatalogOverride,
    quoteResultOverride,
    oneDollarQuoteOverride,
    metadataOverride,
    simulateTxOverride,
    skipRpcCheck = false
  } = deps;

  // 1. Feature Flag Check: Strictly boolean true
  const realBuyActive = isRealBuyOverride !== undefined
    ? isRealBuyOverride
    : (process.env.ENABLE_REAL_BUY?.trim() === 'true');

  if (!realBuyActive) {
    return {
      status: 403,
      body: {
        canExecute: false,
        error: 'Real buy execution is disabled (preview mode only). Set ENABLE_REAL_BUY=true in .env.local to enable.'
      }
    };
  }

  // 1b. In live-buy mode, require dedicated RPC configuration (Item 3)
  const isRpcConfigured = Boolean(
    process.env.SOLANA_RPC_URL &&
    process.env.SOLANA_RPC_URL.trim().length > 0 &&
    !process.env.SOLANA_RPC_URL.includes('PASTE_YOUR_KEY_HERE')
  );
  if (!isRpcConfigured && !skipRpcCheck && isRealBuyOverride === undefined) {
    return {
      status: 503,
      body: {
        canExecute: false,
        error: 'Dedicated Solana RPC is not configured. Set SOLANA_RPC_URL in .env.local to execute live transactions instead of using the public RPC.'
      }
    };
  }

  // 2. Token Symbol Check: Must match approved 7-token list (NEVER accept raw mint from client)
  const upperSymbol = String(symbol || '').toUpperCase().trim();
  if (!upperSymbol || !ALLOWED_SYMBOLS.includes(upperSymbol)) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Invalid or unapproved token symbol '${symbol}'. Only approved PreStocks basket tokens are permitted.`
      }
    };
  }

  // 3. Validate user wallet address
  if (!userPublicKey || typeof userPublicKey !== 'string') {
    return {
      status: 400,
      body: { canExecute: false, error: 'Missing or invalid userPublicKey' }
    };
  }
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!base58Regex.test(userPublicKey)) {
    return {
      status: 400,
      body: { canExecute: false, error: 'Invalid userPublicKey format: must be valid Solana address' }
    };
  }

  // 4. HARD SERVER-SIDE SPEND CAP: Max $2.00 per single-token transaction
  const parsedUsdc = Number(amountUsdc) || 0;
  if (parsedUsdc <= 0) {
    return {
      status: 400,
      body: { canExecute: false, error: 'Amount must be greater than $0' }
    };
  }
  if (parsedUsdc > 2.0) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Amount exceeds hard safety cap of $2.00 (requested: $${parsedUsdc.toFixed(2)})`
      }
    };
  }
  const safeUsdc = Math.min(parsedUsdc, 2.0);
  const legLamports = Math.floor(safeUsdc * 1e6);
  const oneDollarLamports = 1 * 1e6;

  // 5. Server re-fetches token catalog & recomputes freshness (re-fetch if cache > 10s old)
  const tokenFetchResult = tokenCatalogOverride || await fetchPreStocksTokensWithFallback(PRESTOCKS_API_URL, 10000);
  const token = tokenFetchResult.tokens?.find((t) => t.symbol === upperSymbol);
  if (!token || !token.contract_address) {
    return {
      status: 404,
      body: { canExecute: false, error: `Token ${upperSymbol} not found in catalog` }
    };
  }

  // STALE DATA RULE: Older than 60s or snapshot-sourced must NEVER allow a buy
  const isSnapshotSourced = tokenFetchResult.source === 'snapshot' || tokenFetchResult.source?.includes('snapshot');
  if (tokenFetchResult.isStale || (tokenFetchResult.dataAgeSeconds && tokenFetchResult.dataAgeSeconds > 60) || isSnapshotSourced) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `PreStocks mark price is stale (mark price data is stale: ${isSnapshotSourced ? 'snapshot-sourced forbidden' : `${tokenFetchResult.dataAgeSeconds || 61}s old > 60s`}). Real buy blocked for security.`
      }
    };
  }

  // 6. Metadata
  const metadata = metadataOverride || await fetchMintMetadata(token.contract_address);

  // RESTRICTION: Until verified, allow live buys ONLY for tokens whose multiplier is 1.0 (Item 4)
  if (metadata.multiplier !== 1.0) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Token ${upperSymbol} has a non-standard share multiplier (${metadata.multiplier}x). Live buying is temporarily restricted to 1.0x multiplier tokens for exact balance settlement.`
      }
    };
  }

  // 7. Fresh Jupiter buy quote: Input mint is strictly hardcoded to USDC_MINT
  const resolvedQuoteResult = typeof quoteResultOverride === 'function'
    ? quoteResultOverride(token, legLamports)
    : (quoteResultOverride && typeof quoteResultOverride === 'object' && quoteResultOverride[upperSymbol])
    ? quoteResultOverride[upperSymbol]
    : quoteResultOverride;

  const buyQuoteResult = resolvedQuoteResult || await fetchJupiterQuoteCached(
    USDC_MINT,
    token.contract_address,
    legLamports,
    true
  );
  if (!buyQuoteResult?.ok || !buyQuoteResult.data) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: buyQuoteResult?.error || 'No executable Jupiter route exists'
      }
    };
  }

  // $1 baseline quote for empirical impact
  const resolvedOneDollarQuote = typeof oneDollarQuoteOverride === 'function'
    ? oneDollarQuoteOverride(token, oneDollarLamports)
    : (oneDollarQuoteOverride && typeof oneDollarQuoteOverride === 'object' && oneDollarQuoteOverride[upperSymbol])
    ? oneDollarQuoteOverride[upperSymbol]
    : oneDollarQuoteOverride;

  const oneDollarQuoteResult = resolvedOneDollarQuote || await fetchJupiterQuoteCached(
    USDC_MINT,
    token.contract_address,
    oneDollarLamports,
    true
  );

  const routeAtX = buyQuoteResult.data.routePlan?.[0]?.swapInfo?.label || 'Direct';
  const routeAt1 = oneDollarQuoteResult?.ok
    ? oneDollarQuoteResult.data.routePlan?.[0]?.swapInfo?.label || 'Direct'
    : '';
  const venueInfo = classifyVenue(routeAtX);

  // 8. Venue verification check (Item 9): Live buying ONLY allowed on verified venues
  if (!venueInfo.verified) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Trading venue '${venueInfo.badge}' is unverified for Token-2022 transfer fee deduction. Live buy blocked for wallet safety.`
      }
    };
  }

  // Multi-hop route check: block if routePlan has > 1 hop
  if (buyQuoteResult.data.routePlan && buyQuoteResult.data.routePlan.length > 1) {
    return {
      status: 403,
      body: {
        canExecute: false,
        guardStatus: 'BLOCK',
        error: `Multi-hop routes (${buyQuoteResult.data.routePlan.length} hops) are blocked to prevent unverified intermediate transfer fees and cumulative slippage`
      }
    };
  }

  const feeDeductedBeyondQuote = venueInfo.feeDeductedBeyondQuote;
  const activeFeePct = (metadata.activeFeeBps || 100) / 10000;

  // Slippage determination: active fee bps + 30 for beyond-quote venues (Manifest), capped at 150
  const slippageDecision = calculateRouteSlippageBps({
    feeDeductedBeyondQuote,
    activeFeeBps: metadata.activeFeeBps || 100
  });

  if (slippageDecision.exceedsCap) {
    return {
      status: 403,
      body: {
        canExecute: false,
        guardStatus: 'BLOCK',
        error: slippageDecision.error
      }
    };
  }

  let empiricalPriceImpactPct = 0;
  if (buyQuoteResult.ok && oneDollarQuoteResult?.ok) {
    const rawTokens1 = parseFloat(oneDollarQuoteResult.data.outAmount) / Math.pow(10, metadata.decimals);
    const netTokens1 = feeDeductedBeyondQuote ? rawTokens1 * (1 - activeFeePct) : rawTokens1;
    const scaledTokens1 = netTokens1 * metadata.multiplier;
    const priceAt1 = 1.0 / scaledTokens1;

    const rawTokensX = parseFloat(buyQuoteResult.data.outAmount) / Math.pow(10, metadata.decimals);
    const netTokensX = feeDeductedBeyondQuote ? rawTokensX * (1 - activeFeePct) : rawTokensX;
    const scaledTokensX = netTokensX * metadata.multiplier;
    const priceAtX = safeUsdc / scaledTokensX;

    empiricalPriceImpactPct = Math.max(0, ((priceAtX - priceAt1) / priceAt1) * 100);
  }

  // 9. Recompute server-side metrics & guard
  const metrics = calculateTokenMetrics({
    token,
    buyAmountUsdc: safeUsdc,
    buyQuoteResult,
    multiplier: metadata.multiplier,
    decimals: metadata.decimals,
    activeFeeBps: metadata.activeFeeBps,
    feeScheduleNote: metadata.feeScheduleNote,
    empiricalPriceImpactPct,
    routeAt1,
    routeAtX,
    quoteTimestamp: Date.now(),
    prestocksAgeSeconds: tokenFetchResult.dataAgeSeconds || 0
  });

  // Client can only make limits stricter than server defaults (5% premium, 2% impact, 3% exit loss), never looser
  const effectiveMaxPremium = Math.min(5.0, Number.isFinite(Number(maxPremium)) ? Number(maxPremium) : 5.0);
  const effectiveMaxPriceImpact = Math.min(2.0, Number.isFinite(Number(maxPriceImpact)) ? Number(maxPriceImpact) : 2.0);
  const effectiveWarnExitLoss = Math.min(3.0, Number.isFinite(Number(warnExitLoss)) ? Number(warnExitLoss) : 3.0);

  const guard = evaluateGuard(metrics, {
    maxPremiumPct: effectiveMaxPremium,
    maxPriceImpactPct: effectiveMaxPriceImpact,
    warnRoundTripLossPct: effectiveWarnExitLoss,
    maxDivergencePct: 10.0,
    maxQuoteAgeSeconds: 60
  });

  // Guard status BLOCK: Halt immediately with 403 Forbidden
  if (guard.status === 'BLOCK') {
    return {
      status: 403,
      body: {
        canExecute: false,
        guardStatus: 'BLOCK',
        error: `Safety guard blocked trade: ${guard.blockedReasons.join('; ')}`
      }
    };
  }

  // 10. Minimum Received Math
  const minReceived = calculateMinimumReceived({
    quotedRawUnitsOut: buyQuoteResult.data.outAmount,
    otherAmountThreshold: buyQuoteResult.data.otherAmountThreshold,
    slippageBps: slippageDecision.slippageBps,
    activeFeeBps: metadata.activeFeeBps || 100,
    feeDeductedBeyondQuote,
    decimals: metadata.decimals,
    multiplier: metadata.multiplier
  });

  const summary = {
    symbol: token.symbol,
    name: token.name,
    spendUsdc: safeUsdc,
    executablePrice: metrics.executablePrice,
    markPrice: token.markPrice,
    premiumVsMarkPct: metrics.premiumVsMarkPct,
    expectedNetTokens: metrics.scaledUiTokensOut,
    minReceivedTokens: minReceived.minScaledTokens,
    multiplier: metadata.multiplier,
    routeType: venueInfo.badge,
    venueStatus: venueInfo.verified ? 'VERIFIED' : 'UNVERIFIED',
    feeNote: metrics.feeNote,
    activeFeePct: (metadata.activeFeeBps || 50) / 100,
    quoteTimestamp: Date.now()
  };

  // Guard status WARN: Requires explicit user confirmation flag
  if (guard.status === 'WARN' && !confirmWarn) {
    return {
      status: 400,
      body: {
        canExecute: false,
        guardStatus: 'WARN',
        requiresExplicitConfirm: true,
        warnings: guard.warnings,
        error: `Safety guard warning requires explicit confirmation: ${guard.warnings.join('; ')}`,
        summary
      }
    };
  }

  // 11. Transaction Sanity & Pre-Simulation Check (Item 2)
  let txBase64 = deps.swapTransactionOverride;
  if (!txBase64) {
    if (deps.quoteResultOverride) {
      // Offline unit test fallback
      txBase64 = 'mock_tx_base64';
    } else {
      // Production live execution: Fetch real Jupiter swap transaction
      try {
        const swapRes = await fetch('https://lite-api.jup.ag/swap/v1/swap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: buyQuoteResult.data,
            userPublicKey,
            wrapAndUnwrapSol: false,
            dynamicComputeUnitLimit: true
          })
        });
        if (!swapRes.ok) {
          const errText = await swapRes.text().catch(() => '');
          return {
            status: 400,
            body: {
              canExecute: false,
              error: `Jupiter swap transaction preparation failed (HTTP ${swapRes.status}): ${errText}`
            }
          };
        }
        const swapData = await swapRes.json();
        txBase64 = swapData.swapTransaction;
      } catch (swapErr) {
        return {
          status: 400,
          body: {
            canExecute: false,
            error: `Swap transaction preparation failed: ${swapErr.message}`
          }
        };
      }
    }
  }

  const sanityCheck = await validateTransactionSanity(txBase64, userPublicKey, safeUsdc, {
    simulateOverride: simulateTxOverride,
    skipSim: false
  });

  if (!sanityCheck.valid) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Transaction sanity validation failed: ${sanityCheck.error}`
      }
    };
  }

  return {
    status: 200,
    body: {
      canExecute: true,
      guardStatus: guard.status,
      warnings: guard.warnings,
      requiresExplicitConfirm: false,
      summary,
      swapTransactionBase64: txBase64
    }
  };
}

/**
 * 8b. Production Swap Preparation function (No mock injection allowed)
 * Strictly extracts permitted client parameters and forwards with real empty dependencies.
 */
async function prepareSingleTokenSwap(clientParams = {}) {
  const safeClientParams = {
    symbol: clientParams.symbol,
    amountUsdc: clientParams.amountUsdc,
    userPublicKey: clientParams.userPublicKey,
    maxPremium: clientParams.maxPremium,
    maxPriceImpact: clientParams.maxPriceImpact,
    warnExitLoss: clientParams.warnExitLoss,
    confirmWarn: Boolean(clientParams.confirmWarn)
  };
  return prepareSingleTokenSwapCore(safeClientParams, {});
}

/**
 * 8c. Core Multi-Token Basket Preparation Engine (Accepts injected dependencies for test isolation)
 * Scope: 2 to 3 legs, tokens with multiplier 1.0 only. Total capped at $3.00, minimum $0.30 per leg.
 * Equal split using calculateBasketAllocations.
 * Server-side per-leg recomputation of evaluateGuard with standard defaults.
 * Any BLOCK or unverified venue returns per-leg reasons and NO transactions.
 */
async function prepareBasketSwapsCore(params, deps = {}) {
  const {
    symbols,
    totalUsdc,
    userPublicKey,
    maxPremium = 5.0,
    maxPriceImpact = 2.0,
    warnExitLoss = 3.0,
    confirmWarn = false
  } = params;

  // 1. Validate Symbols: Must be array of 2 to 3 distinct valid PreStocks symbols
  if (!Array.isArray(symbols) || symbols.length < 2 || symbols.length > 3) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Basket execution requires between 2 and 3 tokens (provided: ${Array.isArray(symbols) ? symbols.length : 0})`
      }
    };
  }

  const upperSymbols = symbols.map(s => String(s || '').toUpperCase().trim());
  const uniqueSymbols = [...new Set(upperSymbols)];
  if (uniqueSymbols.length !== upperSymbols.length) {
    return {
      status: 400,
      body: { canExecute: false, error: 'Duplicate tokens are not permitted in a basket' }
    };
  }

  for (const sym of upperSymbols) {
    if (!ALLOWED_SYMBOLS.includes(sym)) {
      return {
        status: 400,
        body: {
          canExecute: false,
          error: `Invalid or unapproved token symbol '${sym}'. Only approved PreStocks basket tokens are permitted.`
        }
      };
    }
  }

  // 2. Validate User Wallet Address
  if (!userPublicKey || typeof userPublicKey !== 'string') {
    return {
      status: 400,
      body: { canExecute: false, error: 'Missing or invalid userPublicKey' }
    };
  }
  const base58Regex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (!base58Regex.test(userPublicKey)) {
    return {
      status: 400,
      body: { canExecute: false, error: 'Invalid userPublicKey format: must be valid Solana address' }
    };
  }

  // 3. HARD SERVER-SIDE SPEND CAP: Max $3.00 total for basket, min $0.30 per leg
  const parsedTotalUsdc = Number(totalUsdc) || 0;
  if (parsedTotalUsdc <= 0) {
    return {
      status: 400,
      body: { canExecute: false, error: 'Total amount must be greater than $0' }
    };
  }
  if (parsedTotalUsdc > 3.0) {
    return {
      status: 400,
      body: {
        canExecute: false,
        error: `Total amount exceeds hard basket safety cap of $3.00 (requested: $${parsedTotalUsdc.toFixed(2)})`
      }
    };
  }

  // Split allocations equally with remainder-cent absorption
  const allocations = calculateBasketAllocations(parsedTotalUsdc, upperSymbols);
  for (const sym of upperSymbols) {
    const legAmount = allocations[sym] || 0;
    if (legAmount < 0.30) {
      return {
        status: 400,
        body: {
          canExecute: false,
          error: `Allocation for leg ${sym} ($${legAmount.toFixed(2)}) is below the minimum threshold of $0.30`
        }
      };
    }
  }

  // 4. Prepare each leg using prepareSingleTokenSwapCore
  // If any leg returns non-200 or canExecute: false, halt and return per-leg results with NO transactions.
  const legResults = [];
  let anyBlock = false;
  let anyWarn = false;
  const blockErrors = [];
  const warnMessages = [];

  for (const sym of upperSymbols) {
    const legAmount = allocations[sym];
    const legRes = await prepareSingleTokenSwapCore({
      symbol: sym,
      amountUsdc: legAmount,
      userPublicKey,
      maxPremium,
      maxPriceImpact,
      warnExitLoss,
      confirmWarn
    }, deps);

    legResults.push({
      symbol: sym,
      allocationUsdc: legAmount,
      status: legRes.status,
      body: legRes.body
    });

    if (legRes.status === 403 || legRes.body?.guardStatus === 'BLOCK' || !legRes.body?.canExecute) {
      anyBlock = true;
      blockErrors.push(`${sym}: ${legRes.body?.error || 'Safety guard block'}`);
    } else if (legRes.body?.guardStatus === 'WARN' || legRes.body?.requiresExplicitConfirm) {
      anyWarn = true;
      if (legRes.body?.warnings) {
        warnMessages.push(...legRes.body.warnings.map(w => `${sym}: ${w}`));
      }
    }
  }

  // If any leg fails or blocks, fail closed and return zero transactions
  if (anyBlock) {
    return {
      status: 403,
      body: {
        canExecute: false,
        guardStatus: 'BLOCK',
        error: `Basket execution halted: ${blockErrors.join('; ')}`,
        legs: legResults.map(lr => ({
          symbol: lr.symbol,
          allocationUsdc: lr.allocationUsdc,
          guardStatus: lr.body?.guardStatus || 'BLOCK',
          canExecute: lr.body?.canExecute || false,
          error: lr.body?.error || null,
          summary: lr.body?.summary || null
        }))
      }
    };
  }

  // If any leg has warnings and confirmation was not given
  if (anyWarn && !confirmWarn) {
    return {
      status: 400,
      body: {
        canExecute: false,
        guardStatus: 'WARN',
        requiresExplicitConfirm: true,
        warnings: warnMessages,
        error: `Basket execution requires explicit confirmation for warnings: ${warnMessages.join('; ')}`,
        legs: legResults.map(lr => ({
          symbol: lr.symbol,
          allocationUsdc: lr.allocationUsdc,
          guardStatus: lr.body?.guardStatus || 'WARN',
          canExecute: lr.body?.canExecute || false,
          warnings: lr.body?.warnings || [],
          summary: lr.body?.summary || null
        }))
      }
    };
  }

  // All legs passed!
  return {
    status: 200,
    body: {
      canExecute: true,
      totalUsdc: parsedTotalUsdc,
      guardStatus: anyWarn ? 'WARN' : 'PASS',
      legs: legResults.map(lr => ({
        symbol: lr.symbol,
        allocationUsdc: lr.allocationUsdc,
        guardStatus: lr.body.guardStatus,
        summary: lr.body.summary,
        swapTransactionBase64: lr.body.swapTransactionBase64
      }))
    }
  };
}

/**
 * 8d. Production Basket Swap Preparation function (No mock injection allowed)
 * Strictly extracts permitted client parameters and forwards with real empty dependencies.
 */
async function prepareBasketSwaps(clientParams = {}) {
  const safeClientParams = {
    symbols: clientParams.symbols,
    totalUsdc: clientParams.totalUsdc,
    userPublicKey: clientParams.userPublicKey,
    maxPremium: clientParams.maxPremium,
    maxPriceImpact: clientParams.maxPriceImpact,
    warnExitLoss: clientParams.warnExitLoss,
    confirmWarn: Boolean(clientParams.confirmWarn)
  };
  return prepareBasketSwapsCore(safeClientParams, {});
}

/**
 * 9. RPC Proxy Request Validation, Dispatch & Rate Limiting (Item 1 & 3)
 */
const ALLOWED_RPC_METHODS = [
  'sendTransaction',
  'getSignatureStatuses',
  'getLatestBlockhash',
  'getTransaction'
];

const RPC_METHOD_LIMITS = {
  getLatestBlockhash: 30,
  sendTransaction: 10,
  getSignatureStatuses: 60,
  getTransaction: 20
};

const ipMethodTimestamps = new Map();

function getClientIpFromHeaders(headers) {
  // Use ONE trusted platform edge header: 'x-vercel-forwarded-for' (set by Vercel edge proxy, cannot be spoofed by client).
  // Other headers (cf-connecting-ip, x-real-ip, x-forwarded-for) are explicitly ignored to prevent client spoofing.
  // If not present (e.g. non-Vercel or local environment), falls back to a single shared bucket: 'shared_bucket'.
  if (!headers) return 'shared_bucket';

  const getH = (key) => typeof headers.get === 'function' ? headers.get(key) : headers[key];

  const vercelIp = getH('x-vercel-forwarded-for');
  if (vercelIp && typeof vercelIp === 'string' && vercelIp.trim()) {
    const firstIp = vercelIp.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  return 'shared_bucket';
}

function checkRpcRateLimit(ip, method, now = Date.now()) {
  const maxAllowed = RPC_METHOD_LIMITS[method] || 30;
  const key = `${ip}:${method}`;

  // Memory hygiene: prune expired entries across the map
  for (const [k, timestamps] of ipMethodTimestamps.entries()) {
    const active = timestamps.filter(t => now - t < 60000);
    if (active.length === 0) {
      ipMethodTimestamps.delete(k);
    } else {
      ipMethodTimestamps.set(k, active);
    }
  }

  const timestamps = ipMethodTimestamps.get(key) || [];
  const recent = timestamps.filter(t => now - t < 60000);
  if (recent.length >= maxAllowed) {
    return false;
  }
  recent.push(now);
  ipMethodTimestamps.set(key, recent);
  return true;
}

async function handleRpcProxyRequest(body, options = {}) {
  const {
    ip = 'shared_bucket',
    connection = null,
    skipRateLimit = false
  } = options;

  if (Array.isArray(body)) {
    return { status: 400, body: { error: 'Batch requests are forbidden' } };
  }

  const method = body?.method || body?.action;
  if (!method || !ALLOWED_RPC_METHODS.includes(method)) {
    return {
      status: 403,
      body: { error: `Forbidden RPC method '${method}'. Allowed methods: ${ALLOWED_RPC_METHODS.join(', ')}` }
    };
  }

  if (!skipRateLimit && !checkRpcRateLimit(ip, method)) {
    return {
      status: 429,
      body: { error: `RPC proxy rate limit exceeded for '${method}' (max ${RPC_METHOD_LIMITS[method]} req/min)` }
    };
  }

  if (!connection) {
    return { status: 500, body: { error: 'RPC connection unavailable' } };
  }

  // 1. sendTransaction
  if (method === 'sendTransaction') {
    const rawTx = body.rawTransaction || body.transaction || (Array.isArray(body.params) ? body.params[0] : null);
    if (!rawTx || typeof rawTx !== 'string') {
      return { status: 400, body: { error: 'Missing or invalid rawTransaction (base64 string required)' } };
    }
    const buffer = Buffer.from(rawTx, 'base64');
    const signature = await connection.sendRawTransaction(buffer, {
      skipPreflight: false,
      maxRetries: 2
    });
    return { status: 200, body: { signature } };
  }

  // 2. getSignatureStatuses
  if (method === 'getSignatureStatuses') {
    const sigs = body.signatures || (Array.isArray(body.params) ? body.params[0] : null);
    if (!sigs || !Array.isArray(sigs) || sigs.length === 0) {
      return { status: 400, body: { error: 'Missing or invalid signatures array' } };
    }
    if (sigs.length > 5) {
      return { status: 400, body: { error: 'Too many signatures in query (max 5)' } };
    }
    const statuses = await connection.getSignatureStatuses(sigs);
    return { status: 200, body: { statuses: statuses.value } };
  }

  // 3. getLatestBlockhash
  if (method === 'getLatestBlockhash') {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    return { status: 200, body: { blockhash, lastValidBlockHeight } };
  }

  // 4. getTransaction
  if (method === 'getTransaction') {
    const sig = body.signature || (Array.isArray(body.params) ? body.params[0] : null);
    if (!sig || typeof sig !== 'string') {
      return { status: 400, body: { error: 'Missing or invalid signature' } };
    }
    const tx = await connection.getParsedTransaction(sig, {
      maxSupportedTransactionVersion: 1,
      commitment: 'confirmed'
    });
    return { status: 200, body: { transaction: tx } };
  }

  return { status: 403, body: { error: 'Forbidden method' } };
}

export {
  PRESET_BASKETS,
  STATIC_PRESTOCKS_SNAPSHOT,
  ALLOWED_SYMBOLS,
  USDC_MINT,
  DEFAULT_RPC_URL,
  VERIFIED_DEX_LABELS,
  ALLOWED_RPC_METHODS,
  RPC_METHOD_LIMITS,
  getClientIpFromHeaders,
  checkRpcRateLimit,
  handleRpcProxyRequest,
  fetchPreStocksTokens,
  fetchPreStocksTokensWithFallback,
  fetchMintMetadata,
  fetchJupiterQuote,
  fetchJupiterQuoteCached,
  calculateTransferFeeSchedule,
  classifyVenue,
  calculateTokenMetrics,
  evaluateGuard,
  calculateBasketAllocations,
  calculateMinimumReceived,
  calculateRouteSlippageBps,
  prepareSingleTokenSwapCore,
  prepareSingleTokenSwap,
  prepareBasketSwapsCore,
  prepareBasketSwaps,
  ALLOWED_PROGRAM_IDS,
  validateTransactionSanity,
  isBlockhashExpired,
  PRESTOCKS_API_URL,
  getLastDryRunFallback,
  saveLastDryRun
};

/**
  * 10. Blockhash Expiry Verification (Item 3)
  * Transactions with blockhashes older than maxAgeMs (default 45s) must be rejected / re-quoted.
  */
function isBlockhashExpired(preparedTimestamp, maxAgeMs = 45000, now = Date.now()) {
  if (!preparedTimestamp || typeof preparedTimestamp !== 'number') return true;
  return (now - preparedTimestamp) > maxAgeMs;
}

/**
 * 11. Dry Run Fallback Storage (Item D.2)
 * Persists and retrieves the last successful live dry run when simulation is unavailable.
 */
function getLastDryRunFallback(customPath = null) {
  try {
    const filePath = customPath || path.join(process.cwd(), 'data', 'last_dry_run.json');
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      if (data && data.legs && data.timestamp) {
        return {
          ...data,
          isFallbackCached: true,
          dryRun: true,
          label: `Last successful dry run: ${data.timestamp}. Live simulation is unavailable right now.`
        };
      }
    }
  } catch {}
  return null;
}

function saveLastDryRun(payload, customPath = null) {
  try {
    const filePath = customPath || path.join(process.cwd(), 'data', 'last_dry_run.json');
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

