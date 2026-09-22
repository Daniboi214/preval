import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Connection, PublicKey } from '@solana/web3.js';

const PRESTOCKS_API_URL = 'https://prestocks.com/api/prestocks';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
const LOCAL_SERVER_BASE = 'http://localhost:3000';

function getRpcUrl() {
  const envRpc = process.env.SOLANA_RPC_URL?.trim();
  if (envRpc && !envRpc.includes('PASTE_YOUR_KEY_HERE')) {
    return envRpc;
  }
  return DEFAULT_RPC;
}

function scanForSecrets(str) {
  const lower = str.toLowerCase();
  const keyword = ['api', 'key='].join('-');
  if (lower.includes(keyword) || lower.includes('helius')) {
    throw new Error('SECURITY VIOLATION: Output contains forbidden keyword. Aborting.');
  }
}

function log(msg) {
  scanForSecrets(String(msg));
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  log('Starting evidence collection...');
  const evidenceData = {
    collectedAt: new Date().toISOString(),
    cluster: {},
    tokens: [],
    localEndpoints: {},
    jupiterQuotes: []
  };

  const rpcUrl = getRpcUrl();
  let rpcHost = 'unknown';
  try {
    rpcHost = new URL(rpcUrl).hostname;
  } catch (e) {
    rpcHost = 'invalid-url';
  }
  log(`RPC HOST NAME: ${rpcHost}`);

  const connection = new Connection(rpcUrl, 'confirmed');

  // 1. Current epoch and slot index
  log('Fetching Solana epoch info...');
  const epochInfo = await connection.getEpochInfo();
  evidenceData.cluster = {
    rpcHost,
    epoch: epochInfo.epoch,
    slotIndex: epochInfo.slotIndex,
    slotsInEpoch: epochInfo.slotsInEpoch,
    absoluteSlot: epochInfo.absoluteSlot,
    rawEpochInfo: epochInfo
  };
  log(`RAW getEpochInfo JSON:\n${JSON.stringify(epochInfo, null, 2)}`);
  log(`Cluster Epoch: ${epochInfo.epoch}, Slot Index: ${epochInfo.slotIndex}/${epochInfo.slotsInEpoch}`);

  // 2. Fetch live token list from PreStocks API (never hardcoded)
  log(`Fetching live token list from PreStocks API (${PRESTOCKS_API_URL})...`);
  const prestocksRes = await fetch(PRESTOCKS_API_URL);
  if (!prestocksRes.ok) {
    throw new Error(`Failed to fetch from PreStocks API: ${prestocksRes.status} ${prestocksRes.statusText}`);
  }
  const liveTokens = await prestocksRes.json();
  log(`Fetched ${liveTokens.length} tokens from PreStocks API.`);

  // 3. For every token: symbol, full mint, older/newer TransferFeeConfig and active fee
  log('Querying on-chain TransferFeeConfig for all tokens...');
  for (const t of liveTokens) {
    const symbol = t.symbol;
    const mintStr = t.contract_address;
    let olderConfig = null;
    let newerConfig = null;
    let activeFeeBps = 0;

    try {
      const pubkey = new PublicKey(mintStr);
      const accInfo = await connection.getParsedAccountInfo(pubkey);
      const extensions = accInfo.value?.data?.parsed?.info?.extensions || [];
      const feeExt = extensions.find(e => e.extension === 'transferFeeConfig');

      if (feeExt?.state) {
        const older = feeExt.state.olderTransferFee;
        const newer = feeExt.state.newerTransferFee;

        olderConfig = older ? {
          epoch: older.epoch,
          transferFeeBasisPoints: older.transferFeeBasisPoints
        } : null;

        newerConfig = newer ? {
          epoch: newer.epoch,
          transferFeeBasisPoints: newer.transferFeeBasisPoints
        } : null;

        if (newer && typeof newer.epoch === 'number' && epochInfo.epoch >= newer.epoch) {
          activeFeeBps = newer.transferFeeBasisPoints ?? 0;
        } else if (older) {
          activeFeeBps = older.transferFeeBasisPoints ?? 0;
        }
      }
    } catch (err) {
      log(`Warning: Failed to fetch on-chain fee for ${symbol} (${mintStr}): ${err.message}`);
    }

    const tokenEntry = {
      symbol,
      mint: mintStr,
      olderTransferFee: olderConfig,
      newerTransferFee: newerConfig,
      activeFeeBps,
      activeFeePercent: `${(activeFeeBps / 100).toFixed(2)}%`
    };

    evidenceData.tokens.push(tokenEntry);
    log(`Token: ${symbol.padEnd(11)} Mint: ${mintStr} | Older: ${JSON.stringify(olderConfig)} | Newer: ${JSON.stringify(newerConfig)} | Active: ${activeFeeBps} bps (${tokenEntry.activeFeePercent})`);
  }

  // 4. Raw JSON from local endpoints
  // 4a. GET /api/health
  log('Calling GET /api/health...');
  try {
    const healthRes = await fetch(`${LOCAL_SERVER_BASE}/api/health`);
    const healthBody = await healthRes.json();
    evidenceData.localEndpoints.health = {
      statusCode: healthRes.status,
      body: healthBody
    };
    log(`GET /api/health [${healthRes.status}]:\n${JSON.stringify(healthBody, null, 2)}`);
  } catch (err) {
    evidenceData.localEndpoints.health = { error: err.message };
    log(`GET /api/health failed: ${err.message}`);
  }

  // 4b. POST /api/quote for ANTHROPIC, ANDURIL, FIGUREAI at $0.90
  log('Calling POST /api/quote for ANTHROPIC, ANDURIL, FIGUREAI at $0.90...');
  let quoteBody = null;
  try {
    const quotePayload = {
      totalUsdc: 0.90,
      selectedSymbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']
    };
    const quoteRes = await fetch(`${LOCAL_SERVER_BASE}/api/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(quotePayload)
    });
    quoteBody = await quoteRes.json();
    evidenceData.localEndpoints.quote = {
      statusCode: quoteRes.status,
      body: quoteBody
    };
    log(`POST /api/quote @ 0.90 [${quoteRes.status}]:\n${JSON.stringify(quoteBody, null, 2)}`);
  } catch (err) {
    evidenceData.localEndpoints.quote = { error: err.message };
    log(`POST /api/quote failed: ${err.message}`);
  }

  // 4b-clamp. Call /api/quote at 0.20 and at 30, printing only clamp fields
  for (const testAmt of [0.20, 30]) {
    try {
      const cRes = await fetch(`${LOCAL_SERVER_BASE}/api/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalUsdc: testAmt,
          selectedSymbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']
        })
      });
      const cBody = await cRes.json();
      log(`POST /api/quote @ ${testAmt}: requestedTotalUsdc=${cBody.requestedTotalUsdc}, totalUsdc=${cBody.totalUsdc}, isClamped=${cBody.isClamped}, clampNote="${cBody.clampNote}"`);
    } catch (err) {
      log(`POST /api/quote @ ${testAmt} failed: ${err.message}`);
    }
  }

  // 4c. POST /api/basket/simulate (report status code and body exactly)
  log('Calling POST /api/basket/simulate for preset trio...');
  let simBody = null;
  try {
    const simPayload = {
      symbols: ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'],
      totalUsdc: 0.90
    };
    const simRes = await fetch(`${LOCAL_SERVER_BASE}/api/basket/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(simPayload)
    });
    simBody = await simRes.json();
    evidenceData.localEndpoints.basketSimulate = {
      statusCode: simRes.status,
      body: simBody
    };
    log(`POST /api/basket/simulate [${simRes.status}]:\n${JSON.stringify(simBody, null, 2)}`);
  } catch (err) {
    evidenceData.localEndpoints.basketSimulate = { error: err.message };
    log(`POST /api/basket/simulate failed: ${err.message}`);
  }

  // 4d. DERIVED CHECKS computed from raw responses (showing numbers used, never hardcoded booleans)
  log('=== DERIVED CHECKS ===');
  // - per preset: quote mark vs simulate mark, difference in dollars and percent
  for (const sym of ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']) {
    const qToken = quoteBody?.tokens?.find(t => t.symbol === sym);
    const sLeg = simBody?.legs?.find(l => l.symbol === sym);
    const qMark = qToken?.markPrice ?? null;
    const sMark = sLeg?.markPrice ?? null;
    let diffDollars = null;
    let diffPct = null;
    if (qMark !== null && sMark !== null) {
      diffDollars = Math.abs(qMark - sMark);
      diffPct = (diffDollars / qMark) * 100;
    }
    log(`Preset ${sym}: Quote Mark = $${qMark}, Simulate Mark = $${sMark}, Diff = $${diffDollars !== null ? diffDollars.toFixed(4) : 'n/a'} (${diffPct !== null ? diffPct.toFixed(2) : 'n/a'}%)`);
  }

  // - absence of simAddress in simulate response (print the keys of the response)
  const simKeys = Object.keys(simBody || {});
  const hasSimAddress = 'simAddress' in (simBody || {});
  log(`Simulate Response Keys: [${simKeys.join(', ')}] | Contains 'simAddress': ${hasSimAddress} (Expected: false)`);

  // - guardStatus from quote versus guardStatus from simulate
  for (const sym of ['ANTHROPIC', 'ANDURIL', 'FIGUREAI']) {
    const qToken = quoteBody?.tokens?.find(t => t.symbol === sym);
    const sLeg = simBody?.legs?.find(l => l.symbol === sym);
    log(`Preset ${sym} Guard Status: Quote = ${qToken?.guardStatus ?? 'n/a'}, Simulate = ${sLeg?.guardStatus ?? 'n/a'}`);
  }

  // - totalUsdc and per-leg amounts in quote
  log(`Quote totalUsdc: ${quoteBody?.totalUsdc}`);
  if (Array.isArray(quoteBody?.tokens)) {
    for (const t of quoteBody.tokens) {
      log(`  Leg ${t.symbol}: allocatedUsdc = ${t.allocatedUsdc}, legUsdc = ${t.legUsdc}`);
    }
  }

  // - whether either response has isFallbackCached or fallback
  const quoteHasFallback = Boolean(quoteBody?.isFallbackCached || quoteBody?.fallback);
  const simHasFallback = Boolean(simBody?.isFallbackCached || simBody?.fallback);
  log(`Fallback Status: Quote hasFallback = ${quoteHasFallback}, Simulate hasFallback = ${simHasFallback}`);

  // - mark age in seconds for both
  const quoteMarkAge = quoteBody?.prestocksStatus?.dataAgeSeconds ?? null;
  const simMarkAges = simBody?.legs?.map(l => `${l.symbol}:${l.markAgeSeconds}s`).join(', ') ?? 'n/a';
  log(`Mark Age: Quote prestocksStatus.dataAgeSeconds = ${quoteMarkAge}s | Simulate leg markAges = [${simMarkAges}]`);

  // - error count across legs
  const simLegErrors = simBody?.legs?.filter(l => l.status === 'FAIL' || l.err !== null)?.length ?? 0;
  log(`Simulate Leg Error Count: ${simLegErrors} (out of ${simBody?.legs?.length ?? 0} legs)`);
  log('======================');

  // 5. One live Jupiter quote per preset at $0.30 with full routePlan
  log('Fetching live Jupiter quotes per preset at $0.30 with full routePlan...');
  const presets = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];
  const dexesParam = encodeURIComponent('Meteora DLMM,Raydium CLMM,Manifest');

  for (const sym of presets) {
    const token = liveTokens.find(t => t.symbol === sym);
    if (!token) {
      log(`Warning: Preset ${sym} not found in live tokens list`);
      continue;
    }
    const jupUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${token.contract_address}&amount=300000&onlyDirectRoutes=true&dexes=${dexesParam}`;
    log(`Fetching Jupiter quote for ${sym} (mint: ${token.contract_address})...`);
    try {
      const jupRes = await fetch(jupUrl);
      const jupData = await jupRes.json();
      const quoteRecord = {
        symbol: sym,
        mint: token.contract_address,
        statusCode: jupRes.status,
        url: jupUrl,
        response: jupData
      };
      evidenceData.jupiterQuotes.push(quoteRecord);
      log(`Jupiter Quote ${sym} [${jupRes.status}]: outAmount=${jupData.outAmount}, routePlan hops=${jupData.routePlan?.length || 0}`);
    } catch (err) {
      log(`Jupiter Quote ${sym} failed: ${err.message}`);
      evidenceData.jupiterQuotes.push({ symbol: sym, error: err.message });
    }
  }

  // 6. Serialize & Secret Verification
  const jsonString = JSON.stringify(evidenceData, null, 2);
  scanForSecrets(jsonString);

  // 7. Save to evidence/evidence-<timestamp>.json
  const evidenceDir = path.join(process.cwd(), 'evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `evidence-${timestamp}.json`;
  const filePath = path.join(evidenceDir, fileName);

  fs.writeFileSync(filePath, jsonString, 'utf8');

  // 8. Compute SHA-256 and print
  const sha256 = crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');

  log('=== EVIDENCE COLLECTION COMPLETE ===');
  log(`Evidence File: ${filePath}`);
  log(`SHA-256: ${sha256}`);
}

main().catch(err => {
  console.error(`[${new Date().toISOString()}] FATAL ERROR:`, err);
  process.exit(1);
});
