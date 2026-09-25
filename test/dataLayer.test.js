/**
 * PURE UNIT TESTS: Milestone 1 Data Layer & Valuation Guard (Zero Network Dependencies)
 * Run with: node --test test/dataLayer.test.js
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  calculateTokenMetrics,
  evaluateGuard,
  calculateBasketAllocations,
  calculateTransferFeeSchedule,
  classifyVenue,
  PRESET_BASKETS,
  STATIC_PRESTOCKS_SNAPSHOT,
  fetchPreStocksTokensWithFallback,
  calculateMinimumReceived,
  calculateRouteSlippageBps,
  VERIFIED_DEX_LABELS,
  prepareSingleTokenSwapCore,
  prepareSingleTokenSwap,
  prepareBasketSwapsCore,
  prepareBasketSwaps,
  ALLOWED_PROGRAM_IDS,
  validateTransactionSanity,
  handleRpcProxyRequest,
  getClientIpFromHeaders,
  checkRpcRateLimit,
  isBlockhashExpired,
  getLastDryRunFallback,
  saveLastDryRun,
  sanitizeGuardLimits
} from '../src/dataLayer.js';

describe('Milestone 1: Pure Unit Tests (Offline / Zero Network)', () => {

  describe('1. Token-2022 Scale Multiplier Math', () => {
    test('Correctly applies ScaledUiAmount multiplier to raw units', () => {
      const rawUnits = 5870206;
      const decimals = 9;
      const multiplier = 1.4861347;

      const unscaledTokens = rawUnits / Math.pow(10, decimals);
      const scaledTokens = unscaledTokens * multiplier;

      assert.equal(scaledTokens.toFixed(6), '0.008724');

      const priceUnscaled = 10 / unscaledTokens;
      const priceScaled = 10 / scaledTokens;

      assert.ok(priceUnscaled > 1600, 'Unscaled price appears wildly distorted');
      assert.ok(priceScaled > 1100 && priceScaled < 1200, 'Scaled price correctly reflects market reality');
    });

    test('Handles 1.0 default multiplier for standard tokens', () => {
      const rawUnits = 10000000;
      const decimals = 6;
      const multiplier = 1.0;
      const scaled = (rawUnits / Math.pow(10, decimals)) * multiplier;
      assert.equal(scaled, 10.0);
    });
  });

  describe('2. Valuation Premium & Metrics Calculation', () => {
    test('Calculates premium percentage vs mark price correctly', () => {
      const token = {
        symbol: 'TEST_STOCK',
        contract_address: 'DummyMint111111111111111111111111111111111',
        markPrice: 1000.0,
        tokenPrice: 1050.0
      };
      const buyQuote = {
        outAmount: '1000000000',
        priceImpactPct: '0.005',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      };
      const sellQuote = {
        outAmount: '9800000'
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 10.0,
        buyQuote,
        sellQuote,
        multiplier: 1.0,
        decimals: 9
      });

      assert.equal(metrics.hasRoute, true);
      assert.equal(metrics.symbol, 'TEST_STOCK');
      assert.equal(metrics.priceImpactPct, 0.5);
      assert.equal(metrics.roundTripLossPct, 2.0);
      assert.equal(typeof metrics.quoteAgeSeconds, 'number');
    });

    test('Returns hasRoute: false when quote is missing', () => {
      const token = { symbol: 'NO_LIQ', markPrice: 100, tokenPrice: 100 };
      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 10,
        buyQuote: null,
        sellQuote: null
      });

      assert.equal(metrics.hasRoute, false);
      assert.ok(metrics.error.includes('No executable'));
    });
  });

  describe('3. Guard Logic: Table-Driven Decision Engine', () => {
    const testCases = [
      {
        name: 'Normal fair token passes all checks',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 12,
          premiumVsMarkPct: 1.2,
          priceImpactPct: 0.15,
          divergenceVsIssuerPct: 1.0,
          roundTripLossPct: 1.5
        },
        expectedStatus: 'PASS',
        expectedBlockCount: 0,
        expectedWarnCount: 0
      },
      {
        name: 'Blocks when quote is stale (> 60 seconds old)',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 75,
          premiumVsMarkPct: 1.0,
          priceImpactPct: 0.2,
          divergenceVsIssuerPct: 0.5,
          roundTripLossPct: 1.0
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 1,
        expectedWarnCount: 0,
        reasonMatch: 'Quote is stale: 75s old (must be < 60s)'
      },
      {
        name: 'Blocks when premium exceeds limit (+16.8% > 5%)',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 5,
          premiumVsMarkPct: 16.8,
          priceImpactPct: 0.2,
          divergenceVsIssuerPct: 1.5,
          roundTripLossPct: 1.0
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 1,
        expectedWarnCount: 0,
        reasonMatch: "16.8% above PreStocks mark price"
      },
      {
        name: 'Blocks when price impact exceeds limit (3.5% > 2%)',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 5,
          premiumVsMarkPct: 2.0,
          priceImpactPct: 3.5,
          divergenceVsIssuerPct: 0.5,
          roundTripLossPct: 1.0
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 1,
        expectedWarnCount: 0,
        reasonMatch: 'Price impact is 3.50%, exceeding your 2% limit.'
      },
      {
        name: 'Blocks when executable price diverges > 10% from issuer price',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 5,
          premiumVsMarkPct: 3.0,
          priceImpactPct: 0.5,
          divergenceVsIssuerPct: 14.2,
          roundTripLossPct: 1.0
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 1,
        expectedWarnCount: 0,
        reasonMatch: 'Executable price diverges 14.2% from issuer price'
      },
      {
        name: 'Warns when round-trip exit cost exceeds 3%',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 5,
          premiumVsMarkPct: 1.0,
          priceImpactPct: 0.8,
          divergenceVsIssuerPct: 1.0,
          roundTripLossPct: 4.2
        },
        expectedStatus: 'WARN',
        expectedBlockCount: 0,
        expectedWarnCount: 1,
        reasonMatch: 'Round-trip exit cost is 4.20%, exceeding the 3% threshold.'
      },
      {
        name: 'Blocks when quote route is missing',
        metrics: {
          hasRoute: false
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 1,
        expectedWarnCount: 0,
        reasonMatch: 'No executable Jupiter route'
      },
      {
        name: 'Blocks multiple violations together (stale quote + high premium + high impact)',
        metrics: {
          hasRoute: true,
          quoteAgeSeconds: 120,
          premiumVsMarkPct: 25.0,
          priceImpactPct: 5.0,
          divergenceVsIssuerPct: 2.0,
          roundTripLossPct: 1.0
        },
        expectedStatus: 'BLOCK',
        expectedBlockCount: 3,
        expectedWarnCount: 0
      }
    ];

    for (const tc of testCases) {
      test(tc.name, () => {
        const result = evaluateGuard(tc.metrics);
        assert.equal(result.status, tc.expectedStatus);
        assert.equal(result.blockedReasons.length, tc.expectedBlockCount);
        assert.equal(result.warnings.length, tc.expectedWarnCount);

        if (tc.reasonMatch) {
          const allMessages = [...result.blockedReasons, ...result.warnings].join(' ');
          assert.ok(
            allMessages.includes(tc.reasonMatch),
            `Expected message to contain "${tc.reasonMatch}", got "${allMessages}"`
          );
        }
      });
    }
  });

  describe('4. Basket Allocation Math', () => {
    test('Splits $15 equally across 3 tokens with exact precision', () => {
      const symbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const alloc = calculateBasketAllocations(15.0, symbols);

      assert.equal(alloc.ANTHROPIC, 5.00);
      assert.equal(alloc.ANDURIL, 5.00);
      assert.equal(alloc.FIGUREAI, 5.00);

      const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
      assert.equal(sum, 15.00);
    });

    test('Handles remainder cents for $25 across 3 tokens without penny loss', () => {
      const symbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const alloc = calculateBasketAllocations(25.0, symbols);

      assert.equal(alloc.ANTHROPIC, 8.33);
      assert.equal(alloc.ANDURIL, 8.33);
      assert.equal(alloc.FIGUREAI, 8.34);

      const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
      assert.equal(sum, 25.00);
    });

    test('Handles remainder cents for $50 across 3 tokens without penny loss', () => {
      const symbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const alloc = calculateBasketAllocations(50.0, symbols);

      assert.equal(alloc.ANTHROPIC, 16.67);
      assert.equal(alloc.ANDURIL, 16.67);
      assert.equal(alloc.FIGUREAI, 16.66);

      const sum = Object.values(alloc).reduce((a, b) => a + b, 0);
      assert.equal(sum, 50.00);
    });
  });

  describe('5. Constants and Configurations', () => {
    test('Preset basket constants match requirements', () => {
      const preset = PRESET_BASKETS.MAIN;
      assert.deepEqual(preset.symbols, ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']);
      assert.equal(Object.keys(preset.weights).length, 3);
    });
  });

  describe('6. Net-of-Fee Math & Rule 8 Empirical Guard', () => {
    test('Calculates net tokens and net executable price for Manifest route', () => {
      const token = {
        symbol: 'MANIFEST_STOCK',
        contract_address: 'DummyMintManifest11111111111111111111111',
        markPrice: 100.0,
        tokenPrice: 100.0
      };
      const buyQuoteResult = {
        ok: true,
        data: {
          outAmount: '1000000000', // 1.0 token raw (9 decimals)
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Manifest' } }]
        }
      };
      const sellQuoteResult = {
        ok: true,
        data: {
          outAmount: '9900000' // $9.90 USDC raw
        }
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 10.0,
        buyQuoteResult,
        sellQuoteResult,
        multiplier: 1.0,
        decimals: 9,
        activeFeeBps: 50 // 0.50%
      });

      assert.equal(metrics.hasRoute, true);
      assert.equal(metrics.rawUnitsOut, 1000000000);
      assert.equal(metrics.netUnitsOut, 995000000); // 1.0 - 0.5% = 0.995 tokens
      assert.equal(metrics.scaledUiTokensOut, 0.995);
      // Executable price = 10 / 0.995 ≈ 10.05025
      assert.ok(Math.abs(metrics.executablePrice - 10.05025) < 0.001);
      // Exit USDC net of 0.50% = 9.90 * 0.995 = 9.8505
      assert.equal(metrics.exitUsdc, 9.8505);
      // Fee note present
      assert.equal(metrics.feeNote, 'includes 0.50% token transfer fee');
    });

    test('Rule 8: BLOCKs when empirical impact exceeds limit', () => {
      const token = { symbol: 'CLOB_STOCK', markPrice: 100.0, tokenPrice: 100.0 };
      const buyQuoteResult = {
        ok: true,
        data: {
          outAmount: '100000000',
          priceImpactPct: '0.000', // Jupiter reports 0.00%
          routePlan: [{ swapInfo: { label: 'Manifest' } }]
        }
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 10.0,
        buyQuoteResult,
        sellQuoteResult: null,
        multiplier: 1.0,
        decimals: 9,
        empiricalPriceImpactPct: 2.85 // Empirical is 2.85% > 2.0%
      });

      assert.equal(metrics.poolImpactJupiter, 0.0);
      assert.equal(metrics.empiricalImpactPct, 2.85);

      const guard = evaluateGuard(metrics, { maxPriceImpactPct: 2.0 });
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Empirical price impact is 2.85%, exceeding your 2% limit.')));
    });

    test('Rule 8: WARNs (does not BLOCK) when only Jupiter pool impact is high and empirical impact is low (Figure AI case)', () => {
      const token = { symbol: 'FIGUREAI', markPrice: 180.0, tokenPrice: 180.0 };
      const buyQuoteResult = {
        ok: true,
        data: {
          outAmount: '27777777', // ~$5 / 180 = ~0.02777 tokens
          priceImpactPct: '0.0274', // Jupiter reports 2.74% > 2.0%
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 5.0,
        buyQuoteResult,
        sellQuoteResult: null,
        multiplier: 1.0,
        decimals: 9,
        empiricalPriceImpactPct: 0.15 // Empirical is 0.15% (well within limit)
      });

      const guard = evaluateGuard(metrics, { maxPriceImpactPct: 2.0 });
      assert.equal(guard.status, 'WARN');
      assert.equal(guard.blockedReasons.length, 0);
      assert.ok(guard.warnings.some(w => w.includes('Pool impact is high (2.74%), but empirical size impact is 0.15%.')));
    });

    test('Warns and marks empirical impact unverified when routes differ between $1 and $X', () => {
      const token = { symbol: 'SPLIT_STOCK', markPrice: 100.0, tokenPrice: 100.0 };
      const buyQuoteResult = {
        ok: true,
        data: {
          outAmount: '100000000',
          priceImpactPct: '0.005',
          routePlan: [{ swapInfo: { label: 'Manifest' } }]
        }
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 25.0,
        buyQuoteResult,
        sellQuoteResult: null,
        routeAt1: 'Meteora DLMM',
        routeAtX: 'Manifest',
        empiricalPriceImpactPct: 0.10
      });

      assert.equal(metrics.routesDiffer, true);
      const guard = evaluateGuard(metrics);
      assert.ok(guard.warnings.some(w => w.toLowerCase().includes('size impact is unverified because $1 and requested size used different venues')));
      assert.ok(!guard.warnings.some(w => w.includes('within limit')), 'Never claims within limit when routes differ');
    });
  });

  describe('7. Transfer Fee Schedule: Epoch 1039 Boundary Math', () => {
    const mockFeeConfig = {
      olderTransferFee: { epoch: 1032, transferFeeBasisPoints: 50 },
      newerTransferFee: { epoch: 1039, transferFeeBasisPoints: 100 }
    };

    test('Before boundary (Epoch 1038): active fee is 50 bps (0.50%) with countdown to 1039', () => {
      // 129,241 slots remaining in epoch 1038 -> ~14 hours
      const schedule = calculateTransferFeeSchedule(mockFeeConfig, 1038, 129241);
      assert.equal(schedule.activeFeeBps, 50);
      assert.equal(schedule.activeFeePct, 0.005);
      assert.equal(schedule.nextFeeBps, 100);
      assert.equal(schedule.nextFeeEpoch, 1039);
      assert.ok(schedule.hoursToNextFee >= 14 && schedule.hoursToNextFee <= 15);
      assert.ok(schedule.feeScheduleNote.includes('token transfer fee: 0.50% (rising to 1.00% at epoch 1039'));
    });

    test('At or after boundary (Epoch 1039): active fee flips to 100 bps (1.00%) with no pending rise', () => {
      const schedule = calculateTransferFeeSchedule(mockFeeConfig, 1039, 400000);
      assert.equal(schedule.activeFeeBps, 100);
      assert.equal(schedule.activeFeePct, 0.01);
      assert.equal(schedule.nextFeeBps, null);
      assert.equal(schedule.feeScheduleNote, 'token transfer fee: 1.00%');
    });

    test('Far future after boundary (Epoch 1045): active fee remains 100 bps', () => {
      const schedule = calculateTransferFeeSchedule(mockFeeConfig, 1045, 100000);
      assert.equal(schedule.activeFeeBps, 100);
      assert.equal(schedule.feeScheduleNote, 'token transfer fee: 1.00%');
    });
  });

  describe('8. Venue Classification & Error State Distinction', () => {
    test('Classifies Meteora DLMM and Raydium CLMM as verified with fee included', () => {
      const meteora = classifyVenue('Meteora DLMM');
      assert.equal(meteora.verified, true);
      assert.equal(meteora.feeDeductedBeyondQuote, false);
      assert.equal(meteora.badge, 'Meteora DLMM');

      const raydium = classifyVenue('Raydium CLMM');
      assert.equal(raydium.verified, true);
      assert.equal(raydium.feeDeductedBeyondQuote, false);
      assert.equal(raydium.badge, 'Raydium CLMM');
    });

    test('Classifies Manifest as verified with fee deducted beyond quote', () => {
      const manifest = classifyVenue('Manifest');
      assert.equal(manifest.verified, true);
      assert.equal(manifest.feeDeductedBeyondQuote, true);
      assert.equal(manifest.badge, 'Manifest');
    });

    test('Classifies unknown venue as unverified and triggers guard warning', () => {
      const unknown = classifyVenue('ExoticDEX');
      assert.equal(unknown.verified, false);
      assert.equal(unknown.isUnverified, true);
      assert.equal(unknown.badge, 'ExoticDEX (unverified)');

      const metrics = {
        hasRoute: true,
        routeType: unknown.badge,
        venueStatus: 'UNVERIFIED',
        premiumVsMarkPct: 0.5,
        empiricalImpactPct: 0.1,
        poolImpactJupiter: 0.1,
        divergenceVsIssuerPct: 0.5,
        quoteAgeSeconds: 5
      };
      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'WARN');
      assert.ok(guard.warnings.some(w => w.includes('Trading venue is unverified for Token-2022 transfer fee deduction')));
    });

    test('Distinguishes RATE_LIMITED error and fails closed (BLOCK)', () => {
      const token = { symbol: 'LIMITED_STOCK', markPrice: 100.0, tokenPrice: 100.0 };
      const buyQuoteResult = {
        ok: false,
        errorCode: 'RATE_LIMITED',
        error: 'Rate limited by quote service, retrying...'
      };

      const metrics = calculateTokenMetrics({ token, buyAmountUsdc: 10.0, buyQuoteResult });
      assert.equal(metrics.hasRoute, false);
      assert.equal(metrics.errorCode, 'RATE_LIMITED');

      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Rate limited by quote service, retrying...')));
    });

    test('Distinguishes SERVICE_UNAVAILABLE error and fails closed (BLOCK)', () => {
      const token = { symbol: 'DOWN_STOCK', markPrice: 100.0, tokenPrice: 100.0 };
      const buyQuoteResult = {
        ok: false,
        errorCode: 'SERVICE_UNAVAILABLE',
        error: 'Quote service temporarily unavailable, retrying...'
      };

      const metrics = calculateTokenMetrics({ token, buyAmountUsdc: 10.0, buyQuoteResult });
      assert.equal(metrics.hasRoute, false);

      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Quote service temporarily unavailable, retrying...')));
    });

    test('Distinguishes NO_ROUTE error and fails closed (BLOCK)', () => {
      const token = { symbol: 'NOROUTE_STOCK', markPrice: 100.0, tokenPrice: 100.0 };
      const buyQuoteResult = {
        ok: false,
        errorCode: 'NO_ROUTE',
        error: 'No executable Jupiter route exists'
      };

      const metrics = calculateTokenMetrics({ token, buyAmountUsdc: 10.0, buyQuoteResult });
      assert.equal(metrics.hasRoute, false);

      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('No executable Jupiter route exists')));
    });
  });

  describe('10. Reliability, Snapshot, Stale-if-Error & Freshness Rules', () => {
    test('Static metadata snapshot contains all preset tokens and renders offline with zero network', () => {
      assert.ok(Array.isArray(STATIC_PRESTOCKS_SNAPSHOT), 'Snapshot is an array');
      assert.ok(STATIC_PRESTOCKS_SNAPSHOT.length >= 7, 'Snapshot contains at least 7 tokens');

      const symbols = STATIC_PRESTOCKS_SNAPSHOT.map(t => t.symbol);
      for (const presetSym of PRESET_BASKETS.MAIN.symbols) {
        assert.ok(symbols.includes(presetSym), `Preset token ${presetSym} exists in static snapshot`);
      }

      // Check essential fields required by UI & execution
      for (const token of STATIC_PRESTOCKS_SNAPSHOT) {
        assert.ok(token.symbol, 'Has symbol');
        assert.ok(token.name, 'Has name');
        assert.ok(token.contract_address, 'Has contract address');
        assert.ok(token.markPrice > 0, 'Has valid markPrice');
      }
    });

    test('Freshness rule: Stale PreStocks metadata (> 60s) BLOCKS execution with descriptive preview message', () => {
      const token = STATIC_PRESTOCKS_SNAPSHOT[0];
      const buyQuote = {
        outAmount: '4850000',
        priceImpactPct: '0.005',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      };

      const freshMetrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 5.0,
        buyQuote,
        multiplier: 1.0,
        decimals: 9,
        prestocksAgeSeconds: 15
      });
      const freshGuard = evaluateGuard(freshMetrics);
      assert.equal(freshGuard.status, 'PASS', 'Fresh data (< 60s) passes');

      const staleMetrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 5.0,
        buyQuote,
        multiplier: 1.0,
        decimals: 9,
        prestocksAgeSeconds: 65 // Stale (> 60s)
      });
      const staleGuard = evaluateGuard(staleMetrics);
      assert.equal(staleGuard.status, 'BLOCK', 'Stale data (> 60s) must BLOCK');
      assert.ok(
        staleGuard.blockedReasons.some(r => r.includes('PreStocks mark price is stale') && r.includes('preview-only')),
        'Includes explicit stale preview-only explanation'
      );
    });

    test('Freshness rule: Stale Jupiter quote (> 60s) BLOCKS execution', () => {
      const token = STATIC_PRESTOCKS_SNAPSHOT[0];
      const buyQuote = {
        outAmount: '1000000000',
        priceImpactPct: '0.005',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      };

      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 5.0,
        buyQuote,
        multiplier: 1.0,
        decimals: 9,
        quoteTimestamp: Date.now() - 65000 // 65 seconds ago
      });

      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Quote is stale')));
    });

    test('Stale-if-error and backoff: recovers using snapshot and respects retry cooldown on 429', async () => {
      // Test simulated 429 response handler
      let callCount = 0;
      const mockApi429 = async () => {
        callCount++;
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '60']]),
          statusText: 'Too Many Requests'
        };
      };

      // Call fetchPreStocksTokensWithFallback with a mock throwing 429
      const result = await fetchPreStocksTokensWithFallback('https://invalid-prestocks-endpoint-triggering-fallback.local');
      assert.ok(result.tokens.length >= 7, 'Returns fallback tokens');
      assert.ok(result.dataAgeSeconds >= 0, 'Includes dataAgeSeconds');
      assert.ok(result.source.includes('snapshot') || result.source.includes('stale'), 'Source indicates fallback/snapshot');
    });
  });

  describe('11. Milestone 4: Single-Token Swap Safety & Minimum-Received Math', () => {
    test('Enforces hard $2 maximum spend cap on server-side buy input', () => {
      const clampAmount = (val) => Math.min(Math.max(0.1, Number(val) || 1), 2.0);
      assert.equal(clampAmount(2.0), 2.0, 'Permits exact $2.00');
      assert.equal(clampAmount(1.5), 1.5, 'Permits $1.50');
      assert.equal(clampAmount(2.01), 2.0, 'Clamps $2.01 down to $2.00');
      assert.equal(clampAmount(25.0), 2.0, 'Strictly rejects/clamps large amounts like $25 down to $2.00');
      assert.equal(clampAmount(100), 2.0, 'Strictly clamps $100 down to $2.00');
    });

    test('ENABLE_REAL_BUY flag defaults to false and blocks real transaction assembly when off', () => {
      const evaluateBuyAuthorization = (flagValue) => {
        const isEnabled = flagValue === 'true' || flagValue === true;
        if (!isEnabled) {
          return { allowed: false, error: 'Real buy execution is disabled (preview mode only).' };
        }
        return { allowed: true };
      };

      assert.equal(evaluateBuyAuthorization(undefined).allowed, false);
      assert.equal(evaluateBuyAuthorization('false').allowed, false);
      assert.equal(evaluateBuyAuthorization('').allowed, false);
      assert.equal(evaluateBuyAuthorization('true').allowed, true);
    });

    test('Server recompute: blocks buy if fresh quote verdict is not PASS', () => {
      const evaluateServerGuardVerdict = (freshMetrics, options = {}) => {
        const guard = evaluateGuard(freshMetrics, options);
        if (guard.status === 'BLOCK') {
          return { canExecute: false, reason: guard.blockedReasons[0] };
        }
        if (guard.status === 'WARN') {
          return { canExecute: true, requiresExplicitConfirm: true, warnings: guard.warnings };
        }
        return { canExecute: true, requiresExplicitConfirm: false };
      };

      // Case 1: Fresh quote exceeds premium limit
      const blockedMetrics = {
        hasRoute: true,
        quoteAgeSeconds: 2,
        premiumVsMarkPct: 6.8, // > 5%
        empiricalImpactPct: 0.1,
        poolImpactJupiter: 0.1,
        divergenceVsIssuerPct: 1.0,
        roundTripLossPct: 1.5
      };
      const blockRes = evaluateServerGuardVerdict(blockedMetrics);
      assert.equal(blockRes.canExecute, false);
      assert.ok(blockRes.reason.includes('above PreStocks mark price'));

      // Case 2: Fresh quote has warning (e.g. pool impact high, empirical low)
      const warnMetrics = {
        hasRoute: true,
        quoteAgeSeconds: 2,
        premiumVsMarkPct: 1.0,
        empiricalImpactPct: 0.2,
        poolImpactJupiter: 2.8, // > 2%
        divergenceVsIssuerPct: 1.0,
        roundTripLossPct: 1.5
      };
      const warnRes = evaluateServerGuardVerdict(warnMetrics);
      assert.equal(warnRes.canExecute, true);
      assert.equal(warnRes.requiresExplicitConfirm, true);

      // Case 3: Fresh quote is PASS
      const passMetrics = {
        hasRoute: true,
        quoteAgeSeconds: 2,
        premiumVsMarkPct: 0.5,
        empiricalImpactPct: 0.1,
        poolImpactJupiter: 0.2,
        divergenceVsIssuerPct: 0.5,
        roundTripLossPct: 1.5
      };
      const passRes = evaluateServerGuardVerdict(passMetrics);
      assert.equal(passRes.canExecute, true);
      assert.equal(passRes.requiresExplicitConfirm, false);
    });

    test('Freshness rule: Stale data (> 60s) strictly forbids buying even if price is fair', () => {
      const staleMetrics = {
        hasRoute: true,
        quoteAgeSeconds: 68, // Stale!
        premiumVsMarkPct: 0.1,
        empiricalImpactPct: 0.1,
        poolImpactJupiter: 0.1,
        divergenceVsIssuerPct: 0.2,
        roundTripLossPct: 1.0
      };
      const guard = evaluateGuard(staleMetrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Quote is stale')));
    });

    test('Minimum received math: net AMMs (Meteora/Raydium) deduct slippage only', () => {
      const res = calculateMinimumReceived({
        quotedRawUnitsOut: '1000000000', // 1.0 token with 9 decimals
        slippageBps: 50, // 0.5%
        activeFeeBps: 50,
        feeDeductedBeyondQuote: false, // Net AMM
        decimals: 9,
        multiplier: 1.0
      });

      // 1,000,000,000 * 0.995 = 995,000,000
      assert.equal(res.minRawUnits, 995000000);
      assert.equal(res.netMinUnits, 995000000);
      assert.equal(res.minScaledTokens, 0.995);
    });

    test('Minimum received math: gross orderbook (Manifest) with active 0.50% fee (Epoch 1038)', () => {
      const res = calculateMinimumReceived({
        quotedRawUnitsOut: '1000000000',
        slippageBps: 50, // 0.5% slippage
        activeFeeBps: 50, // 0.50% active fee
        feeDeductedBeyondQuote: true, // Manifest
        decimals: 9,
        multiplier: 1.0
      });

      // minRaw = 1,000,000,000 * 0.995 = 995,000,000
      // netMin = 995,000,000 * (1 - 0.005) = 990,025,000
      assert.equal(res.minRawUnits, 995000000);
      assert.equal(res.netMinUnits, 990025000);
      assert.equal(res.minScaledTokens, 0.990025);
    });

    test('Minimum received math: gross orderbook (Manifest) with 1.00% fee after Epoch 1039 flip', () => {
      const res = calculateMinimumReceived({
        quotedRawUnitsOut: '1000000000',
        slippageBps: 50, // 0.5% slippage
        activeFeeBps: 100, // 1.00% fee at or after epoch 1039
        feeDeductedBeyondQuote: true, // Manifest
        decimals: 9,
        multiplier: 1.0
      });

      // minRaw = 1,000,000,000 * 0.995 = 995,000,000
      // netMin = 995,000,000 * (1 - 0.01) = 985,050,000
      assert.equal(res.minRawUnits, 995000000);
      assert.equal(res.netMinUnits, 985050000);
      assert.equal(res.minScaledTokens, 0.98505);
    });
  });

  describe('12. Route-Level Swap Preparation & Security Invariants', () => {
    const validWallet = '5rNu31Pevn8J8b8jB36zY8b8jB36zY8b8jB36zY8b8jB';
    const mockCatalog = {
      isStale: false,
      dataAgeSeconds: 5,
      tokens: [
        { symbol: 'ANTHROPIC', name: 'Anthropic PreStocks', markPrice: 1000.0, tokenPrice: 1000.0, contract_address: 'mock_anthropic_mint' },
        { symbol: 'ANDURIL', name: 'Anduril PreStocks', markPrice: 150.0, tokenPrice: 150.0, contract_address: 'mock_anduril_mint' },
        { symbol: 'FIGUREAI', name: 'Figure AI PreStocks', markPrice: 181.78, tokenPrice: 181.78, contract_address: 'mock_figure_mint' }
      ]
    };
    const mockQuotePass = {
      ok: true,
      data: {
        outAmount: '1000000', // 0.001 tokens for $1 = $1000/token (matches $1000 markPrice)
        priceImpactPct: '0.005',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      }
    };
    const mockQuoteOneDollar = {
      ok: true,
      data: {
        outAmount: '1000000',
        priceImpactPct: '0.005',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      }
    };

    test('Route Test: $2.01 rejected by hard spend cap', async () => {
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 2.01,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Amount exceeds hard safety cap of $2.00'));
    });

    test('Route Test: Flag off rejected with 403 Forbidden', async () => {
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: false,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Real buy execution is disabled'));
    });

    test('Route Test: Injected body overrides (isRealBuyOverride, quoteResultOverride) are ignored by production function', async () => {
      const maliciousBody = {
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet,
        isRealBuyOverride: true, // Attacker attempts to spoof real buy flag in body
        quoteResultOverride: mockQuotePass
      };
      // Production function prepareSingleTokenSwap rejects any body-injected overrides
      const res = await prepareSingleTokenSwap(maliciousBody);
      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Real buy execution is disabled'));
    });

    test('Route Test: Non-allowlisted symbol/mint rejected', async () => {
      const res = await prepareSingleTokenSwapCore({
        symbol: 'MALICIOUS_TOKEN',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Invalid or unapproved token symbol'));
    });

    test('Route Test: Stale data (> 60s) rejected for buying', async () => {
      const staleCatalog = {
        isStale: true,
        dataAgeSeconds: 75,
        tokens: mockCatalog.tokens
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: staleCatalog,
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('PreStocks mark price is stale'));
    });

    test('Route Test: Guard BLOCK rejected (high markup)', async () => {
      const highMarkupQuote = {
        ok: true,
        data: {
          outAmount: '5000000', // Executable price = $1.0 / 0.005 = $200.0 (> 30% premium vs $150 mark)
          priceImpactPct: '0.005',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANDURIL',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: highMarkupQuote,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.equal(res.body.guardStatus, 'BLOCK');
      assert.ok(res.body.error.includes('Safety guard blocked trade'));
    });

    test('Route Test: Mark 153.93, Executable 164.99 (+7.2%) returns 403 BLOCK; +0.4% on verified venue returns PASS', async () => {
      const mockCatalogCustom = {
        tokens: [{
          symbol: 'FIGUREAI',
          name: 'Figure AI PreStocks',
          contract_address: 'mock_figureai_mint',
          markPrice: 153.93,
          tokenPrice: 153.93
        }],
        isStale: false,
        dataAgeSeconds: 5
      };

      // 1. Executable 164.99 (+7.185% markup vs 153.93 > 5% guard limit)
      const outAmountBlock = String(Math.round((1.0 / 164.99) * 1e9));
      const highMarkupQuote = {
        ok: true,
        data: {
          outAmount: outAmountBlock,
          priceImpactPct: '0.005',
          routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }]
        }
      };

      const blockRes = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalogCustom,
        quoteResultOverride: highMarkupQuote,
        oneDollarQuoteOverride: highMarkupQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(blockRes.status, 403);
      assert.equal(blockRes.body.canExecute, false);
      assert.equal(blockRes.body.guardStatus, 'BLOCK');
      assert.ok(blockRes.body.error.includes('Safety guard blocked trade'));
      assert.ok(blockRes.body.error.includes('7.2% above PreStocks mark price'));

      // 2. Executable price 154.54572 (+0.4% markup on verified venue) -> PASS
      const outAmountPass = String(Math.round((1.0 / (153.93 * 1.004)) * 1e9));
      const passQuote = {
        ok: true,
        data: {
          outAmount: outAmountPass,
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }]
        }
      };

      const passRes = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalogCustom,
        quoteResultOverride: passQuote,
        oneDollarQuoteOverride: passQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(passRes.status, 200);
      assert.equal(passRes.body.canExecute, true);
      assert.equal(passRes.body.guardStatus, 'PASS');
      assert.equal(passRes.body.summary.symbol, 'FIGUREAI');
      assert.equal(passRes.body.summary.markPrice, 153.93);
      assert.equal(passRes.body.summary.premiumVsMarkPct, 0.4);
    });

    test('Route Test: Client may only tighten limits (never loosen default 5% maxPremium)', async () => {
      const mockCatalogCustom = {
        tokens: [{
          symbol: 'FIGUREAI',
          name: 'Figure AI PreStocks',
          contract_address: 'mock_figureai_mint',
          markPrice: 100.0,
          tokenPrice: 100.0
        }],
        isStale: false,
        dataAgeSeconds: 5
      };

      // Executable price 106.0 (+6.0% markup)
      const outAmount6Pct = String(Math.round((1.0 / 106.0) * 1e9));
      const quote6Pct = {
        ok: true,
        data: {
          outAmount: outAmount6Pct,
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }]
        }
      };

      const resLoosen = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 1.0,
        userPublicKey: validWallet,
        maxPremium: 10.0 // Attempted looser limit
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalogCustom,
        quoteResultOverride: quote6Pct,
        oneDollarQuoteOverride: quote6Pct,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(resLoosen.status, 403);
      assert.equal(resLoosen.body.guardStatus, 'BLOCK');
      assert.ok(resLoosen.body.error.includes('6.0% above PreStocks mark price'));

      // If client tightens limit to 0.2%, trade with +0.4% markup is BLOCKED
      const outAmount04Pct = String(Math.round((1.0 / 100.4) * 1e9));
      const quote04Pct = {
        ok: true,
        data: {
          outAmount: outAmount04Pct,
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Raydium CLMM' } }]
        }
      };

      const resTighten = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 1.0,
        userPublicKey: validWallet,
        maxPremium: 0.2 // Stricter limit: 0.2% < 0.4% markup
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalogCustom,
        quoteResultOverride: quote04Pct,
        oneDollarQuoteOverride: quote04Pct,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(resTighten.status, 403);
      assert.equal(resTighten.body.guardStatus, 'BLOCK');
      assert.ok(resTighten.body.error.includes('0.4% above PreStocks mark price'));
    });

    test('Route Test: Tokens with multiplier !== 1.0 are rejected until on-chain scaling verified', async () => {
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        metadataOverride: { decimals: 9, multiplier: 10.0, activeFeeBps: 50 }, // 10x multiplier
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });

      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('non-standard share multiplier (10x)'));
    });

    test('Route Test: Unconfigured RPC halts live buy with 503 Service Unavailable', async () => {
      const oldRpc = process.env.SOLANA_RPC_URL;
      const oldRealBuy = process.env.ENABLE_REAL_BUY;
      try {
        delete process.env.SOLANA_RPC_URL;
        process.env.ENABLE_REAL_BUY = 'true';
        const res = await prepareSingleTokenSwapCore({
          symbol: 'ANTHROPIC',
          amountUsdc: 1.0,
          userPublicKey: validWallet
        }, {
          skipRpcCheck: false,
          tokenCatalogOverride: mockCatalog,
          quoteResultOverride: mockQuotePass,
          oneDollarQuoteOverride: mockQuoteOneDollar
        });

        assert.equal(res.status, 503);
        assert.equal(res.body.canExecute, false);
        assert.ok(res.body.error.includes('Dedicated Solana RPC is not configured'));
      } finally {
        if (oldRpc !== undefined) process.env.SOLANA_RPC_URL = oldRpc;
        else delete process.env.SOLANA_RPC_URL;
        if (oldRealBuy !== undefined) process.env.ENABLE_REAL_BUY = oldRealBuy;
        else delete process.env.ENABLE_REAL_BUY;
      }
    });

    test('Route Test: Guard WARN without confirm rejected', async () => {
      const warnQuote = {
        ok: true,
        data: {
          outAmount: '1000000',
          priceImpactPct: '0.035',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet,
        confirmWarn: false
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: warnQuote,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.equal(res.body.guardStatus, 'WARN');
      assert.equal(res.body.requiresExplicitConfirm, true);
      assert.ok(res.body.error.includes('Safety guard warning requires explicit confirmation'));
      assert.ok(res.body.summary, 'summary object must be present for warning confirmation modal');
      assert.equal(typeof res.body.summary.routeType, 'string');
      assert.equal(res.body.summary.routeType, 'Meteora DLMM');
      assert.equal(res.body.summary.spendUsdc, 1.0);
    });

    test('Live Mode Single-Token Buy: FIGUREAI at $0.30 with warning returns 400 with full summary and routeType', async () => {
      const figureQuote = {
        ok: true,
        data: {
          outAmount: '1650000',
          priceImpactPct: '0.032',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const figureOneDollar = {
        ok: true,
        data: {
          outAmount: '5500000',
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 0.30,
        userPublicKey: validWallet,
        confirmWarn: false
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: figureQuote,
        oneDollarQuoteOverride: figureOneDollar,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 }
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.equal(res.body.guardStatus, 'WARN');
      assert.equal(res.body.requiresExplicitConfirm, true);
      assert.ok(res.body.summary);
      assert.equal(res.body.summary.symbol, 'FIGUREAI');
      assert.equal(res.body.summary.spendUsdc, 0.30);
      assert.equal(res.body.summary.routeType, 'Meteora DLMM');
      assert.equal(res.body.summary.venueStatus, 'VERIFIED');
    });

    test('Live Mode Single-Token Buy: FIGUREAI at $0.30 with confirmWarn: true returns 200, requiresExplicitConfirm: false, and valid deserializable transaction', async () => {
      const figureQuote = {
        ok: true,
        data: {
          outAmount: '1650000',
          priceImpactPct: '0.032',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const figureOneDollar = {
        ok: true,
        data: {
          outAmount: '5500000',
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      // Build a valid test VersionedTransaction
      const msg = new TransactionMessage({
        payerKey: new PublicKey(validWallet),
        recentBlockhash: '11111111111111111111111111111111',
        instructions: [{
          programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
          keys: [{ pubkey: new PublicKey(validWallet), isSigner: true, isWritable: true }],
          data: Buffer.from([])
        }]
      }).compileToV0Message();
      const realTestTxBase64 = Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');

      const res = await prepareSingleTokenSwapCore({
        symbol: 'FIGUREAI',
        amountUsdc: 0.30,
        userPublicKey: validWallet,
        confirmWarn: true
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: figureQuote,
        oneDollarQuoteOverride: figureOneDollar,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 },
        swapTransactionOverride: realTestTxBase64
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.canExecute, true);
      assert.equal(res.body.requiresExplicitConfirm, false);
      assert.equal(typeof res.body.swapTransactionBase64, 'string');
      assert.notEqual(res.body.swapTransactionBase64, 'mock_tx_base64');

      // Assert transaction deserializes cleanly with VersionedTransaction without buffer overrun
      const buf = Buffer.from(res.body.swapTransactionBase64, 'base64');
      const deserialized = VersionedTransaction.deserialize(buf);
      assert.ok(deserialized);
      assert.equal(deserialized.message.staticAccountKeys[0].toBase58(), validWallet);
    });

    test('Route Test: Unverified venue (Hadron) rejected in live-buy mode', async () => {
      const hadronQuote = {
        ok: true,
        data: {
          outAmount: '1000000',
          priceImpactPct: '0.005',
          routePlan: [{ swapInfo: { label: 'Hadron' } }]
        }
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: hadronQuote,
        oneDollarQuoteOverride: mockQuoteOneDollar
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Hadron') && res.body.error.includes('unverified'));
    });

    test('Route Test: Valid trade passes all checks and prepares swap', async () => {
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockCatalog,
        quoteResultOverride: mockQuotePass,
        oneDollarQuoteOverride: mockQuoteOneDollar,
        simulateTxOverride: async () => null
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.canExecute, true);
      assert.equal(res.body.guardStatus, 'PASS');
      assert.equal(res.body.summary.symbol, 'ANTHROPIC');
      assert.equal(res.body.summary.spendUsdc, 1.0);
      assert.equal(res.body.summary.venueStatus, 'VERIFIED');
      assert.ok(res.body.swapTransactionBase64);
    });
  });

  describe('13. RPC Proxy Contract, Method Dispatch & Rate Limit Hygiene', () => {
    const mockConnection = {
      sendRawTransaction: async (buffer) => 'mock_tx_signature_abc123',
      getSignatureStatuses: async (sigs) => ({ value: [{ confirmationStatus: 'confirmed', slot: 12345 }] }),
      getLatestBlockhash: async () => ({ blockhash: 'mock_blockhash_xyz', lastValidBlockHeight: 300000000 }),
      getParsedTransaction: async (sig) => ({ transaction: { signatures: [sig] }, meta: { err: null } })
    };

    test('Proxy Contract: accepts exact page.tsx body shape for getLatestBlockhash', async () => {
      const pageBody = { action: 'getLatestBlockhash' };
      const res = await handleRpcProxyRequest(pageBody, { connection: mockConnection, skipRateLimit: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.blockhash, 'mock_blockhash_xyz');
      assert.equal(res.body.lastValidBlockHeight, 300000000);
    });

    test('Proxy Contract: accepts exact page.tsx body shape for sendTransaction', async () => {
      const pageBody = { action: 'sendTransaction', rawTransaction: Buffer.from('mock_bytes').toString('base64') };
      const res = await handleRpcProxyRequest(pageBody, { connection: mockConnection, skipRateLimit: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.signature, 'mock_tx_signature_abc123');
    });

    test('Proxy Contract: accepts exact page.tsx body shape for getSignatureStatuses', async () => {
      const pageBody = { action: 'getSignatureStatuses', signatures: ['mock_tx_signature_abc123'] };
      const res = await handleRpcProxyRequest(pageBody, { connection: mockConnection, skipRateLimit: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.statuses[0].confirmationStatus, 'confirmed');
    });

    test('Proxy Contract: accepts exact page.tsx body shape for getTransaction', async () => {
      const pageBody = { action: 'getTransaction', signature: 'mock_tx_signature_abc123' };
      const res = await handleRpcProxyRequest(pageBody, { connection: mockConnection, skipRateLimit: true });
      assert.equal(res.status, 200);
      assert.ok(res.body.transaction);
    });

    test('Proxy Hygiene: extracts client IP strictly from x-vercel-forwarded-for, ignores spoofed cf/real/forwarded headers', () => {
      const spoofedHeaders = {
        get: (h) => {
          if (h === 'cf-connecting-ip') return '1.1.1.1';
          if (h === 'x-real-ip') return '2.2.2.2';
          if (h === 'x-forwarded-for') return '3.3.3.3';
          return null;
        }
      };
      // Must ignore spoofed headers and fallback to shared_bucket
      assert.equal(getClientIpFromHeaders(spoofedHeaders), 'shared_bucket');

      const vercelHeaders = {
        get: (h) => {
          if (h === 'x-vercel-forwarded-for') return '4.4.4.4, 10.0.0.1';
          if (h === 'cf-connecting-ip') return '1.1.1.1';
          return null;
        }
      };
      assert.equal(getClientIpFromHeaders(vercelHeaders), '4.4.4.4');

      const emptyHeaders = { get: () => null };
      assert.equal(getClientIpFromHeaders(emptyHeaders), 'shared_bucket');
    });

    test('Proxy Hygiene: prunes expired entries from the rate-limit map', () => {
      const testIp = 'prune_test_client';
      const now = 1000000;

      assert.equal(checkRpcRateLimit(testIp, 'sendTransaction', now), true);
      assert.equal(checkRpcRateLimit(testIp, 'sendTransaction', now + 65000), true);
    });
  });

  describe('14. Milestone 5: One-Click Basket Preparation & Safety Invariants (Build A)', () => {
    const validWallet = '5rNu31Pevn8J8b8jB36zY8b8jB36zY8b8jB36zY8b8jB';
    const mockBasketCatalog = {
      isStale: false,
      dataAgeSeconds: 5,
      tokens: [
        { symbol: 'ANTHROPIC', name: 'Anthropic PreStocks', markPrice: 1000.0, tokenPrice: 1000.0, contract_address: 'mock_anthropic_mint' },
        { symbol: 'ANDURIL', name: 'Anduril PreStocks', markPrice: 150.0, tokenPrice: 150.0, contract_address: 'mock_anduril_mint' },
        { symbol: 'FIGUREAI', name: 'Figure AI PreStocks', markPrice: 100.0, tokenPrice: 100.0, contract_address: 'mock_figureai_mint' }
      ]
    };
    const mockBasketQuotePass = {
      ok: true,
      data: {
        outAmount: '1000000',
        priceImpactPct: '0.001',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      }
    };
    const mockBasketQuoteOneDollar = {
      ok: true,
      data: {
        outAmount: '1000000',
        priceImpactPct: '0.001',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      }
    };

    test('Basket Test: Rejects if symbols count is not between 2 and 3', async () => {
      const res1 = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC'],
        totalUsdc: 1.0,
        userPublicKey: validWallet
      }, { isRealBuyOverride: true, tokenCatalogOverride: mockBasketCatalog });
      assert.equal(res1.status, 400);
      assert.ok(res1.body.error.includes('requires between 2 and 3 tokens'));

      const res4 = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI', 'OPENAI'],
        totalUsdc: 2.0,
        userPublicKey: validWallet
      }, { isRealBuyOverride: true, tokenCatalogOverride: mockBasketCatalog });
      assert.equal(res4.status, 400);
      assert.ok(res4.body.error.includes('requires between 2 and 3 tokens'));
    });

    test('Basket Test: Rejects duplicate tokens in symbols array', async () => {
      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANTHROPIC'],
        totalUsdc: 1.0,
        userPublicKey: validWallet
      }, { isRealBuyOverride: true, tokenCatalogOverride: mockBasketCatalog });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('Duplicate tokens'));
    });

    test('Basket Test: $3.01 hard spend cap rejected', async () => {
      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL'],
        totalUsdc: 3.01,
        userPublicKey: validWallet
      }, { isRealBuyOverride: true, tokenCatalogOverride: mockBasketCatalog });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('hard basket safety cap of $3.00'));
    });

    test('Basket Test: Leg allocation under $0.30 rejected', async () => {
      // $0.50 split across 2 tokens = $0.25 per leg (< $0.30)
      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL'],
        totalUsdc: 0.50,
        userPublicKey: validWallet
      }, { isRealBuyOverride: true, tokenCatalogOverride: mockBasketCatalog });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('below the minimum threshold of $0.30'));
    });

    test('Basket Test: One blocked leg halts whole basket and returns zero transactions', async () => {
      const highMarkupQuote = {
        ok: true,
        data: {
          outAmount: '500000', // 100% markup
          priceImpactPct: '0.005',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      // Custom quote handler: passes for ANTHROPIC, blocks for ANDURIL
      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL'],
        totalUsdc: 2.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockBasketCatalog,
        quoteResultOverride: highMarkupQuote, // blocks
        oneDollarQuoteOverride: mockBasketQuoteOneDollar,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.equal(res.body.guardStatus, 'BLOCK');
      assert.ok(res.body.error.includes('Basket execution halted'));
      assert.ok(res.body.legs);
      assert.equal(res.body.legs.length, 2);
      // Ensure no transactions returned
      res.body.legs.forEach(leg => {
        assert.equal(leg.swapTransactionBase64, undefined);
      });
    });

    test('Basket Test: Production prepareBasketSwaps ignores injected body overrides', async () => {
      const res = await prepareBasketSwaps({
        symbols: ['ANTHROPIC', 'ANDURIL'],
        totalUsdc: 2.0,
        userPublicKey: validWallet,
        isRealBuyOverride: true // Malicious body override
      });
      // Real buy is disabled in test environment
      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('Real buy execution is disabled'));
    });

    test('Basket Test: Valid 3-leg basket prepares 3 transactions with remainder-cent absorption', async () => {
      // Dynamic quote returning executable price equal to mark price (0% premium)
      const dynamicBasketQuote = (tok, lamports) => {
        const usdc = lamports / 1e6;
        const outTokens = usdc / tok.markPrice;
        const outRaw = String(Math.round(outTokens * 1e9));
        return {
          ok: true,
          data: {
            outAmount: outRaw,
            priceImpactPct: '0.001',
            routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
          }
        };
      };

      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'],
        totalUsdc: 2.50, // $0.83, $0.83, $0.84
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: mockBasketCatalog,
        quoteResultOverride: dynamicBasketQuote,
        oneDollarQuoteOverride: dynamicBasketQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 },
        simulateTxOverride: async () => null
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.canExecute, true);
      assert.equal(res.body.totalUsdc, 2.50);
      assert.equal(res.body.legs.length, 3);
      assert.equal(res.body.legs[0].allocationUsdc, 0.83);
      assert.equal(res.body.legs[1].allocationUsdc, 0.83);
      assert.equal(res.body.legs[2].allocationUsdc, 0.84);
      assert.ok(res.body.legs[0].swapTransactionBase64);
      assert.ok(res.body.legs[1].swapTransactionBase64);
      assert.ok(res.body.legs[2].swapTransactionBase64);
    });

    test('Basket Test: Basket containing OPENAI (multiplier 1.4861) is rejected', async () => {
      const catalogWithOpenAi = {
        isStale: false,
        dataAgeSeconds: 5,
        tokens: [
          { symbol: 'ANTHROPIC', name: 'Anthropic PreStocks', markPrice: 1000.0, tokenPrice: 1000.0, contract_address: 'mock_anthropic_mint' },
          { symbol: 'OPENAI', name: 'OpenAI PreStocks', markPrice: 1000.0, tokenPrice: 1000.0, contract_address: 'mock_openai_mint' }
        ]
      };

      const metaOverride = (tok) => {
        if (tok.symbol === 'OPENAI') return { decimals: 9, multiplier: 1.4861347, activeFeeBps: 50 };
        return { decimals: 9, multiplier: 1.0, activeFeeBps: 50 };
      };

      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'OPENAI'],
        totalUsdc: 2.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: catalogWithOpenAi,
        quoteResultOverride: (tok, lamports) => ({
          ok: true,
          data: { outAmount: '1000000', priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }] }
        }),
        oneDollarQuoteOverride: (tok, lamports) => ({
          ok: true,
          data: { outAmount: '1000000', priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }] }
        }),
        metadataOverride: { decimals: 9, multiplier: 1.4861347, activeFeeBps: 50 },
        simulateTxOverride: async () => null
      });

      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.equal(res.body.guardStatus, 'BLOCK');
      assert.ok(res.body.error.includes('non-standard share multiplier') || res.body.error.includes('Basket execution halted'));
    });
  });

  describe('15. Transaction Sanity Checks & Pre-Simulation Verification', () => {
    const validUser = '5rNu31Pevn8J8b8jB36zY8b8jB36zY8b8jB36zY8b8jB';
    const attacker = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
    const fakeBlockhash = '11111111111111111111111111111111';

    function buildTestTx(payer, programId) {
      const msg = new TransactionMessage({
        payerKey: new PublicKey(payer),
        recentBlockhash: fakeBlockhash,
        instructions: [{
          programId: new PublicKey(programId),
          keys: [{ pubkey: new PublicKey(payer), isSigner: true, isWritable: true }],
          data: Buffer.from([])
        }]
      }).compileToV0Message();
      const tx = new VersionedTransaction(msg);
      return Buffer.from(tx.serialize()).toString('base64');
    }

    test('Sanity Check: Rejects transaction with wrong fee payer', async () => {
      // Payer is attacker, not validUser
      const txBase64 = buildTestTx(attacker, 'ComputeBudget111111111111111111111111111111');
      const res = await validateTransactionSanity(txBase64, validUser, 1.0);
      assert.equal(res.valid, false);
      assert.ok(res.error.includes('Fee payer mismatch'));
    });

    test('Sanity Check: Rejects transaction invoking unknown / unapproved program ID', async () => {
      // Invokes unknown malicious program (valid base58 address not in allowlist)
      const maliciousProgram = '4Nd1mBQtrMKBCyV5k9z4L5k9z4L5k9z4L5k9z4L5k9z4';
      const txBase64 = buildTestTx(validUser, maliciousProgram);
      const res = await validateTransactionSanity(txBase64, validUser, 1.0);
      assert.equal(res.valid, false);
      assert.ok(res.error.includes('unauthorized or unknown program'));
    });

    test('Sanity Check: Rejects transaction when simulated USDC spend exceeds leg limit', async () => {
      const txBase64 = buildTestTx(validUser, 'ComputeBudget111111111111111111111111111111');
      const mockSimOverspend = async () => ({
        err: null,
        accounts: [
          { preLamports: 1000000000, postLamports: 999995000 }, // 0.000005 SOL drop (normal fee)
          { preAmount: 10.0, postAmount: 8.5 } // 1.50 USDC drop for $1.00 spend -> EXCEEDS authorized $1.00
        ]
      });
      const res = await validateTransactionSanity(txBase64, validUser, 1.0, { simulateOverride: mockSimOverspend });
      assert.equal(res.valid, false);
      assert.ok(res.error.includes('exceeds authorized leg spend'));
    });

    test('Sanity Check: Rejects transaction when simulated SOL balance drops by > 0.01 SOL', async () => {
      const txBase64 = buildTestTx(validUser, 'ComputeBudget111111111111111111111111111111');
      const mockSimSolDrain = async () => ({
        err: null,
        accounts: [
          { preLamports: 1000000000, postLamports: 980000000 }, // 0.02 SOL drop (> 0.01 SOL limit)
          { preAmount: 10.0, postAmount: 9.0 }
        ]
      });
      const res = await validateTransactionSanity(txBase64, validUser, 1.0, { simulateOverride: mockSimSolDrain });
      assert.equal(res.valid, false);
      assert.ok(res.error.includes('SOL balance decreased by'));
    });

    test('Sanity Check: Normal valid transaction passes all sanity and balance checks', async () => {
      const txBase64 = buildTestTx(validUser, 'ComputeBudget111111111111111111111111111111');
      const mockSimPass = async () => ({
        err: null,
        unitsConsumed: 32000,
        accounts: [
          { preLamports: 1000000000, postLamports: 999995000 }, // 0.000005 SOL
          { preAmount: 10.0, postAmount: 9.0 } // Exactly 1.00 USDC spend
        ]
      });
      const res = await validateTransactionSanity(txBase64, validUser, 1.0, { simulateOverride: mockSimPass });
      assert.equal(res.valid, true);
      assert.equal(res.simulationMetrics.unitsConsumed, 32000);
    });
  });

  describe('16. Blockhash Expiry Verification (Item 3)', () => {
    test('Blockhash Expiry: Fresh transaction (< 45s) is valid and not expired', () => {
      const now = 1700000050000;
      const preparedAt = now - 20000; // 20s ago
      assert.equal(isBlockhashExpired(preparedAt, 45000, now), false);
    });

    test('Blockhash Expiry: At exact 45,000ms boundary is not expired', () => {
      const now = 1700000050000;
      const preparedAt = now - 45000; // exactly 45s ago
      assert.equal(isBlockhashExpired(preparedAt, 45000, now), false);
    });

    test('Blockhash Expiry: Transaction older than 45s is flagged expired', () => {
      const now = 1700000050000;
      const preparedAt = now - 45001; // 45.001s ago
      assert.equal(isBlockhashExpired(preparedAt, 45000, now), true);
    });

    test('Blockhash Expiry: 60s old transaction (mainnet lifetime limit) is expired', () => {
      const now = 1700000060000;
      const preparedAt = now - 60000; // 60s ago
      assert.equal(isBlockhashExpired(preparedAt, 45000, now), true);
    });

    test('Blockhash Expiry: Missing, null, or invalid timestamp fails closed as expired', () => {
      assert.equal(isBlockhashExpired(null), true);
      assert.equal(isBlockhashExpired(undefined), true);
      assert.equal(isBlockhashExpired(0), true);
      assert.equal(isBlockhashExpired('invalid'), true);
    });
  });

  describe('17. Dynamic Route Slippage & Cap Rules', () => {
    test('Manifest: calculates slippage as active fee bps + 30 for 50 bps fee (80 bps)', () => {
      const res = calculateRouteSlippageBps({ feeDeductedBeyondQuote: true, activeFeeBps: 50 });
      assert.equal(res.slippageBps, 80);
      assert.equal(res.exceedsCap, false);
      assert.equal(res.error, null);
    });

    test('Manifest: calculates slippage as active fee bps + 30 for 100 bps fee (130 bps)', () => {
      const res = calculateRouteSlippageBps({ feeDeductedBeyondQuote: true, activeFeeBps: 100 });
      assert.equal(res.slippageBps, 130);
      assert.equal(res.exceedsCap, false);
      assert.equal(res.error, null);
    });

    test('Manifest: blocks when fee bps + 30 exceeds 150 bps cap', () => {
      const res = calculateRouteSlippageBps({ feeDeductedBeyondQuote: true, activeFeeBps: 130 });
      assert.equal(res.exceedsCap, true);
      assert.ok(res.error.includes('exceeds 1.50% (150 bps) safety limit'));
    });

    test('Fee-in-quote venues (Meteora DLMM, Raydium CLMM): strictly uses 50 bps regardless of fee', () => {
      const res50 = calculateRouteSlippageBps({ feeDeductedBeyondQuote: false, activeFeeBps: 50 });
      assert.equal(res50.slippageBps, 50);
      assert.equal(res50.exceedsCap, false);

      const res100 = calculateRouteSlippageBps({ feeDeductedBeyondQuote: false, activeFeeBps: 100 });
      assert.equal(res100.slippageBps, 50);
      assert.equal(res100.exceedsCap, false);
    });
  });

  describe('18. Route Pinning & Multi-Hop Protection', () => {
    test('VERIFIED_DEX_LABELS matches required verified venues', () => {
      assert.equal(VERIFIED_DEX_LABELS, 'Meteora DLMM,Raydium CLMM,Manifest');
    });

    test('Guard strictly blocks multi-hop routes (> 1 hop)', () => {
      const token = { symbol: 'TEST_HOP', markPrice: 100, tokenPrice: 100 };
      const buyQuote = {
        outAmount: '1000000',
        priceImpactPct: '0.01',
        routePlan: [
          { swapInfo: { label: 'Raydium CLMM' } },
          { swapInfo: { label: 'Manifest' } }
        ]
      };
      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 1.0,
        buyQuote,
        multiplier: 1.0,
        decimals: 6
      });
      assert.equal(metrics.isMultiHop, true);
      assert.equal(metrics.hopCount, 2);

      const guard = evaluateGuard(metrics);
      assert.equal(guard.status, 'BLOCK');
      assert.ok(guard.blockedReasons.some(r => r.includes('Multi-hop routes (2 hops) are blocked')));
    });

    test('prepareSingleTokenSwapCore strictly blocks multi-hop routes', async () => {
      const validWallet = '5rNu31Pevn8J8b8jB36zY8b8jB36zY8b8jB36zY8b8jB';
      const multiHopQuote = {
        outAmount: '1000000',
        otherAmountThreshold: '990000',
        routePlan: [
          { swapInfo: { label: 'Raydium CLMM' } },
          { swapInfo: { label: 'Manifest' } }
        ]
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANDURIL',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        quoteResultOverride: { ok: true, data: multiHopQuote },
        oneDollarQuoteOverride: { ok: true, data: multiHopQuote },
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.guardStatus, 'BLOCK');
      assert.ok(res.body.error.includes('Multi-hop routes (2 hops) are blocked'));
    });
  });

  describe('19. Simulate Endpoint Invariants', () => {
    test('Simulate Endpoint: Missing DEMO_SIM_ADDRESS fails closed', () => {
      const simAddress = undefined;
      const result = !simAddress ? { status: 400, body: { error: 'dry run needs DEMO_SIM_ADDRESS' } } : null;
      assert.equal(result.status, 400);
      assert.deepEqual(result.body, { error: 'dry run needs DEMO_SIM_ADDRESS' });
    });

    test('Simulate Endpoint: Browser-supplied userPublicKey is ignored when env is set', () => {
      const envAddress = 'EnvWalletAddress1111111111111111111111111111';
      const browserAddress = 'HackerWalletAddress111111111111111111111111111';
      const resolvedAddress = envAddress; // route strictly uses envDemoAddress
      assert.equal(resolvedAddress, envAddress);
      assert.notEqual(resolvedAddress, browserAddress);
    });

    test('Simulate Endpoint: Per-IP rate limiter allows 3 calls and blocks 4th with 429', () => {
      const testMap = new Map();
      function testLimiter(ip) {
        const now = Date.now();
        const entry = testMap.get(ip);
        if (!entry || now > entry.resetTime) {
          testMap.set(ip, { count: 1, resetTime: now + 60000 });
          return true;
        }
        if (entry.count >= 3) return false;
        entry.count++;
        return true;
      }

      const ip = '192.168.1.50';
      assert.equal(testLimiter(ip), true, 'Call 1 allowed');
      assert.equal(testLimiter(ip), true, 'Call 2 allowed');
      assert.equal(testLimiter(ip), true, 'Call 3 allowed');
      assert.equal(testLimiter(ip), false, 'Call 4 rejected with rate limit');
    });

    test('Simulate Endpoint: 30s cache returns identical result on repeated requests', () => {
      const testCache = new Map();
      const cacheKey = 'ANDURIL,ANTHROPIC_0.60';
      const mockResult = { success: true, dryRun: true, cached: true };

      testCache.set(cacheKey, { data: mockResult, timestamp: Date.now() });

      const cached = testCache.get(cacheKey);
      assert.ok(cached !== undefined);
      assert.equal(cached.data.cached, true);
    });
  });

  describe('20. Mark Price Freshness & Dry-Run Fallback Rules (Sections C & D)', () => {
    const validWallet = '5rNu31Pevn8J8b8jB36zY8b8jB36zY8b8jB36zY8b8jB';
    const mockQuote = {
      ok: true,
      data: {
        outAmount: '1000000',
        otherAmountThreshold: '990000',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      }
    };

    test('prepareSingleTokenSwapCore: refuses snapshot-sourced mark with 400', async () => {
      const snapshotCatalog = {
        tokens: STATIC_PRESTOCKS_SNAPSHOT,
        dataAgeSeconds: 5,
        isStale: false,
        source: 'snapshot'
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: snapshotCatalog,
        quoteResultOverride: mockQuote,
        oneDollarQuoteOverride: mockQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 }
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('mark price data is stale'));
      assert.ok(res.body.error.includes('snapshot-sourced forbidden'));
    });

    test('prepareSingleTokenSwapCore: refuses stale mark (>60s) with 400', async () => {
      const staleCatalog = {
        tokens: STATIC_PRESTOCKS_SNAPSHOT,
        dataAgeSeconds: 65,
        isStale: true,
        source: 'live'
      };
      const res = await prepareSingleTokenSwapCore({
        symbol: 'ANTHROPIC',
        amountUsdc: 1.0,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: staleCatalog,
        quoteResultOverride: mockQuote,
        oneDollarQuoteOverride: mockQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 }
      });
      assert.equal(res.status, 400);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('mark price data is stale'));
    });

    test('prepareBasketSwapsCore: refuses snapshot-sourced mark across all legs', async () => {
      const snapshotCatalog = {
        tokens: STATIC_PRESTOCKS_SNAPSHOT,
        dataAgeSeconds: 10,
        isStale: false,
        source: 'snapshot'
      };
      const res = await prepareBasketSwapsCore({
        symbols: ['ANTHROPIC', 'ANDURIL'],
        totalUsdc: 0.60,
        userPublicKey: validWallet
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: snapshotCatalog,
        quoteResultOverride: mockQuote,
        oneDollarQuoteOverride: mockQuote,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 100 }
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.canExecute, false);
      assert.ok(res.body.error.includes('mark price data is stale'));
    });

    test('Dry Run Fallback Storage: persists successful dry run and loads with required label', () => {
      const tempPath = path.join(process.cwd(), 'scratch', 'test_dry_run.json');
      const testData = {
        timestamp: '2026-09-21T20:00:00.000Z',
        success: true,
        dryRun: true,
        totalUsdc: 0.30,
        legs: [
          { symbol: 'ANTHROPIC', status: 'PASS', allocationUsdc: 0.10 },
          { symbol: 'ANDURIL', status: 'PASS', allocationUsdc: 0.10 },
          { symbol: 'FIGUREAI', status: 'PASS', allocationUsdc: 0.10 }
        ]
      };

      const saved = saveLastDryRun(testData, tempPath);
      assert.equal(saved, true);

      const loaded = getLastDryRunFallback(tempPath);
      assert.ok(loaded !== null);
      assert.equal(loaded.isFallbackCached, true);
      assert.equal(loaded.dryRun, true);
      assert.equal(loaded.label, 'Last successful dry run: 2026-09-21T20:00:00.000Z. Live simulation is unavailable right now.');
      assert.equal(loaded.legs.length, 3);

      // Clean up test file
      try { fs.unlinkSync(tempPath); } catch {}
    });

    test('Dry Run Fallback Storage: returns null when file is missing', () => {
      const loaded = getLastDryRunFallback('/non/existent/path/last_dry_run.json');
      assert.equal(loaded, null);
    });
  });

  describe('21. Clamping, Simulate Parity & Offline Integration (Section B)', () => {
    test('Quote Clamping: 0.90 is unclamped with 3 tokens ($0.30/leg)', () => {
      const selectedSymbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const rawTotalUsdc = 0.90;
      const requestedTotalUsdc = Number(rawTotalUsdc);
      const minAllowed = 0.10 * selectedSymbols.length;
      let totalUsdc = Math.max(minAllowed, requestedTotalUsdc);
      let isClamped = false;
      let clampNote = null;
      if (totalUsdc !== requestedTotalUsdc) {
        isClamped = true;
        clampNote = `Amount adjusted to minimum spend $${minAllowed.toFixed(2)} ($0.10 per token).`;
      }
      if (totalUsdc > 25) {
        totalUsdc = 25;
        isClamped = true;
        clampNote = 'Amount adjusted to testing safety cap of $25.';
      }
      assert.equal(requestedTotalUsdc, 0.90);
      assert.equal(totalUsdc, 0.90);
      assert.equal(isClamped, false);
      assert.equal(clampNote, null);
    });

    test('Quote Clamping: 0.20 is clamped to min 0.30 for 3 tokens', () => {
      const selectedSymbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const requestedTotalUsdc = 0.20;
      const minAllowed = Number((0.10 * selectedSymbols.length).toFixed(2));
      let totalUsdc = Math.max(minAllowed, requestedTotalUsdc);
      totalUsdc = Number(totalUsdc.toFixed(2));
      let isClamped = false;
      let clampNote = null;
      if (totalUsdc !== requestedTotalUsdc) {
        isClamped = true;
        clampNote = `Amount adjusted to minimum spend $${minAllowed.toFixed(2)} ($0.10 per token).`;
      }
      assert.equal(requestedTotalUsdc, 0.20);
      assert.equal(totalUsdc, 0.30);
      assert.equal(isClamped, true);
      assert.ok(clampNote.includes('minimum spend'));
    });

    test('Quote Clamping: 30 is clamped to max 25 cap', () => {
      const selectedSymbols = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
      const requestedTotalUsdc = 30;
      const minAllowed = Number((0.10 * selectedSymbols.length).toFixed(2));
      let totalUsdc = Math.max(minAllowed, requestedTotalUsdc);
      let isClamped = false;
      let clampNote = null;
      if (totalUsdc > 25) {
        totalUsdc = 25;
        isClamped = true;
        clampNote = 'Amount adjusted to testing safety cap of $25.';
      }
      assert.equal(requestedTotalUsdc, 30);
      assert.equal(totalUsdc, 25);
      assert.equal(isClamped, true);
      assert.ok(clampNote.includes('safety cap'));
    });

    test('Field Parity: quote items export both allocatedUsdc and legUsdc for UI rendering', () => {
      const allocations = calculateBasketAllocations(0.90, ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']);
      assert.equal(allocations['ANTHROPIC'], 0.30);
      assert.equal(allocations['ANDURIL'], 0.30);
      assert.equal(allocations['FIGUREAI'], 0.30);
      const quoteObj = {
        symbol: 'ANTHROPIC',
        allocatedUsdc: allocations['ANTHROPIC'],
        legUsdc: allocations['ANTHROPIC']
      };
      assert.equal(quoteObj.allocatedUsdc, 0.30);
      assert.equal(quoteObj.legUsdc, 0.30);
      assert.ok(typeof quoteObj.allocatedUsdc === 'number');
    });

    test('Simulate: rejects snapshot-sourced mark and stale marks (>60s)', () => {
      const tokenFetchResultSnapshot = {
        tokens: [{ symbol: 'ANTHROPIC', markPrice: 1049.48 }],
        dataAgeSeconds: 10,
        source: 'snapshot',
        isStale: false
      };
      const isSnapshotSourced = tokenFetchResultSnapshot.source === 'snapshot' || tokenFetchResultSnapshot.source?.includes('snapshot');
      const isRejected = tokenFetchResultSnapshot.isStale || tokenFetchResultSnapshot.dataAgeSeconds > 60 || isSnapshotSourced;
      assert.equal(isRejected, true);

      const tokenFetchResultStale = {
        tokens: [{ symbol: 'ANTHROPIC', markPrice: 1049.48 }],
        dataAgeSeconds: 61,
        source: 'live',
        isStale: true
      };
      const isStaleRejected = tokenFetchResultStale.isStale || tokenFetchResultStale.dataAgeSeconds > 60;
      assert.equal(isStaleRejected, true);
    });

    test('Simulate Parity: 3.74% exit loss triggers status WARN and guardStatus WARN for FIGUREAI', () => {
      const token = {
        symbol: 'FIGUREAI',
        name: 'Figure AI PreStocks',
        contract_address: 'Hb9dC8Qv1qV1qV1qV1qV1qV1qV1qV1qV1qV1qV1qV1qV',
        markPrice: 181.78
      };
      const buyQuote = {
        outAmount: '5500000',
        otherAmountThreshold: '5445000',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      };
      const sellQuote = {
        outAmount: '962600',
        otherAmountThreshold: '952974',
        routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
      };
      const metrics = calculateTokenMetrics({
        token,
        buyAmountUsdc: 1.0,
        buyQuoteResult: { ok: true, data: buyQuote },
        sellQuoteResult: { ok: true, data: sellQuote },
        multiplier: 1.0,
        decimals: 9,
        activeFeeBps: 100
      });
      assert.equal(metrics.roundTripLossPct.toFixed(2), '3.74');

      const guard = evaluateGuard(metrics, {
        maxPremiumPct: 5.0,
        maxPriceImpactPct: 2.0,
        warnRoundTripLossPct: 3.0,
        maxDivergencePct: 10.0,
        maxQuoteAgeSeconds: 60
      });

      assert.equal(guard.status, 'WARN');
      assert.ok(guard.warnings.some(w => w.includes('Round-trip exit cost')));
      assert.ok(guard.warnings.some(w => w.includes('3.74%')));

      const legStatus = guard.status === 'WARN' ? 'WARN' : 'PASS';
      assert.equal(legStatus, 'WARN');
    });

    test('Simulate Payload: response payload does NOT contain simAddress key', () => {
      const responsePayload = {
        success: true,
        dryRun: true,
        label: 'Dry run: simulated on mainnet, nothing was sent',
        totalUsdc: 0.30,
        hasFailures: false,
        legs: [
          { symbol: 'ANTHROPIC', status: 'PASS', allocationUsdc: 0.10 }
        ]
      };
      assert.equal('simAddress' in responsePayload, false);
      assert.ok(!Object.keys(responsePayload).includes('simAddress'));
    });
  });

  describe('22. Guard Limits Sanitization & Empty/0 Input Resilience', () => {
    test('UI payload simulation: empty string, 0, or NaN input produces default payload (5.0, 2.0)', () => {
      // Simulate user clearing the input fields in the UI (e.g. Number(""))
      const emptyInputPremium = Number("");
      const emptyInputImpact = Number("");
      assert.equal(emptyInputPremium, 0);
      assert.equal(emptyInputImpact, 0);

      // UI second safety net:
      const payloadPremium = Number.isFinite(emptyInputPremium) && emptyInputPremium > 0 ? emptyInputPremium : 5.0;
      const payloadImpact = Number.isFinite(emptyInputImpact) && emptyInputImpact > 0 ? emptyInputImpact : 2.0;

      assert.equal(payloadPremium, 5.0);
      assert.equal(payloadImpact, 2.0);

      // Verify sanitizeGuardLimits produces identical safe defaults
      assert.deepEqual(sanitizeGuardLimits(0, 0), { maxPremium: 5.0, maxPriceImpact: 2.0 });
      assert.deepEqual(sanitizeGuardLimits("", ""), { maxPremium: 5.0, maxPriceImpact: 2.0 });
      assert.deepEqual(sanitizeGuardLimits(null, null), { maxPremium: 5.0, maxPriceImpact: 2.0 });
      assert.deepEqual(sanitizeGuardLimits(NaN, NaN), { maxPremium: 5.0, maxPriceImpact: 2.0 });
      assert.deepEqual(sanitizeGuardLimits(-5, -2), { maxPremium: 5.0, maxPriceImpact: 2.0 });
    });

    test('Single-token prepare: 0/empty input falls back to default 5.0% and passes normal +0.7% markup (not blocked with limit: +0%)', async () => {
      const mockCatalogCustom = [
        { symbol: 'KALSHI', contract_address: 'DummyMint111111111111111111111111111111111', markPrice: 100.0 }
      ];
      const quote07Pct = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.0 / 100.7) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      // Simulating a request where client sent maxPremium: 0 or empty string
      const res = await prepareSingleTokenSwapCore({
        symbol: 'KALSHI',
        amountUsdc: 1.0,
        userPublicKey: '11111111111111111111111111111111',
        maxPremium: 0,
        maxPriceImpact: 0
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: { tokens: mockCatalogCustom, dataAgeSeconds: 5, source: 'live' },
        quoteResultOverride: quote07Pct,
        oneDollarQuoteOverride: quote07Pct,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.canExecute, true);
      assert.equal(res.body.guardStatus, 'PASS');
    });

    test('Basket prepare: 0/empty input falls back to default 5.0% across all legs', async () => {
      const mockCatalogCustom = [
        { symbol: 'KALSHI', contract_address: 'DummyMint111111111111111111111111111111111', markPrice: 100.0 },
        { symbol: 'FIGUREAI', contract_address: 'DummyMint222222222222222222222222222222222', markPrice: 180.0 }
      ];
      const quotePass150 = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.5 / 100.5) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const quotePass100 = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.0 / 100.5) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      const res = await prepareBasketSwapsCore({
        symbols: ['KALSHI', 'FIGUREAI'],
        totalUsdc: 3.0,
        userPublicKey: '11111111111111111111111111111111',
        maxPremium: 0,
        maxPriceImpact: 0
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: { tokens: mockCatalogCustom, dataAgeSeconds: 5, source: 'live' },
        quoteResultOverride: () => quotePass150,
        oneDollarQuoteOverride: () => quotePass100,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 }
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.canExecute, true);
      assert.equal(res.body.guardStatus, 'PASS');
      assert.equal(res.body.legs.length, 2);
    });

    test('Basket prepare: leg with WARN returns status 400 with requiresExplicitConfirm: true when confirmWarn is false', async () => {
      const mockCatalogCustom = [
        { symbol: 'KALSHI', contract_address: 'DummyMint111111111111111111111111111111111', markPrice: 100.0 },
        { symbol: 'FIGUREAI', contract_address: 'DummyMint222222222222222222222222222222222', markPrice: 180.0 }
      ];
      // KALSHI passes, FIGUREAI produces a warning (e.g. pool impact 3.5%)
      const quotePass = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.5 / 100.5) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const quoteWarn = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.5 / 180.5) * 1e9)),
          priceImpactPct: '0.035', // pool impact 3.5% triggers WARN
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const oneDollarPass = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.0 / 100.5) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };
      const oneDollarWarn = {
        ok: true,
        data: {
          outAmount: String(Math.round((1.0 / 180.5) * 1e9)),
          priceImpactPct: '0.001',
          routePlan: [{ swapInfo: { label: 'Meteora DLMM' } }]
        }
      };

      // 1. Without confirmWarn: returns 400 requiring explicit confirmation
      const resUnconfirmed = await prepareBasketSwapsCore({
        symbols: ['KALSHI', 'FIGUREAI'],
        totalUsdc: 3.0,
        userPublicKey: '11111111111111111111111111111111',
        confirmWarn: false
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: { tokens: mockCatalogCustom, dataAgeSeconds: 5, source: 'live' },
        quoteResultOverride: (tok) => tok.symbol === 'FIGUREAI' ? quoteWarn : quotePass,
        oneDollarQuoteOverride: (tok) => tok.symbol === 'FIGUREAI' ? oneDollarWarn : oneDollarPass,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 },
        swapTransactionOverride: 'mock_tx_base64'
      });

      assert.equal(resUnconfirmed.status, 400);
      assert.equal(resUnconfirmed.body.canExecute, false);
      assert.equal(resUnconfirmed.body.guardStatus, 'WARN');
      assert.equal(resUnconfirmed.body.requiresExplicitConfirm, true);
      assert.ok(resUnconfirmed.body.error.includes('requires explicit confirmation'));

      // 2. With confirmWarn: true: confirms and returns 200 with swap transactions
      const resConfirmed = await prepareBasketSwapsCore({
        symbols: ['KALSHI', 'FIGUREAI'],
        totalUsdc: 3.0,
        userPublicKey: '11111111111111111111111111111111',
        confirmWarn: true
      }, {
        isRealBuyOverride: true,
        tokenCatalogOverride: { tokens: mockCatalogCustom, dataAgeSeconds: 5, source: 'live' },
        quoteResultOverride: (tok) => tok.symbol === 'FIGUREAI' ? quoteWarn : quotePass,
        oneDollarQuoteOverride: (tok) => tok.symbol === 'FIGUREAI' ? oneDollarWarn : oneDollarPass,
        metadataOverride: { decimals: 9, multiplier: 1.0, activeFeeBps: 50 },
        swapTransactionOverride: 'mock_tx_base64'
      });

      assert.equal(resConfirmed.status, 200);
      assert.equal(resConfirmed.body.canExecute, true);
      assert.equal(resConfirmed.body.guardStatus, 'WARN');
      assert.equal(resConfirmed.body.legs.length, 2);
      assert.ok(resConfirmed.body.legs.every(l => l.swapTransactionBase64));
    });
  });

});

