'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';

const WalletMultiButton = dynamic(
  async () => (await import('@solana/wallet-adapter-react-ui')).WalletMultiButton,
  { ssr: false }
);

interface TokenQuote {
  symbol: string;
  name: string;
  mint: string;
  allocatedUsdc: number;
  hasRoute: boolean;
  errorCode: string | null;
  error: string | null;
  markPrice: number;
  issuerPrice: number;
  executablePrice: number | null;
  premiumVsMarkPct: number | null;
  priceImpactPct: number | null;
  poolImpactJupiter: number | null;
  empiricalImpactPct: number | null;
  governingPriceImpactPct: number | null;
  feeNote: string | null;
  feeScheduleNote?: string;
  venueStatus?: string;
  routeType: string | null;
  routesDiffer?: boolean;
  routeAt1?: string;
  routeAtX?: string;
  exitUsdc: number | null;
  roundTripLossPct: number | null;
  quoteAgeSeconds: number;
  guardStatus: 'PASS' | 'WARN' | 'BLOCK';
  blockedReasons: string[];
  warnings: string[];
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface SwapReceipt {
  signature: string;
  symbol: string;
  amountUsdc: number;
  expectedNetTokens: number;
  minTokens: number;
  actualTokensReceived: number | null;
  diffTokens?: number | null;
  solscanUrl: string;
  timestamp: string;
  isTimeout?: boolean;
}

const ALL_AVAILABLE_TOKENS = [
  { symbol: 'ANTHROPIC', name: 'Anthropic PreStocks', desc: 'Claude AI developer' },
  { symbol: 'ANDURIL', name: 'Anduril PreStocks', desc: 'Autonomous defense tech' },
  { symbol: 'FIGUREAI', name: 'Figure AI PreStocks', desc: 'Humanoid robotics' },
  { symbol: 'OPENAI', name: 'OpenAI PreStocks', desc: 'ChatGPT & frontier models' },
  { symbol: 'NEURALINK', name: 'Neuralink PreStocks', desc: 'Brain-computer interfaces' },
  { symbol: 'KALSHI', name: 'Kalshi PreStocks', desc: 'Regulated prediction exchange' },
  { symbol: 'POLYMARKET', name: 'Polymarket PreStocks', desc: 'Decentralized prediction market' },
];

const PRESET_MAIN = ['ANTHROPIC', 'ANDURIL', 'FIGUREAI'];

export default function Home() {
  // Main preset is strictly ANTHROPIC, ANDURIL, FIGUREAI
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(PRESET_MAIN);
  const [amountUsdc, setAmountUsdc] = useState<number>(0.90);
  const [clampNote, setClampNote] = useState<string | null>(null);
  const [maxPremium, setMaxPremium] = useState<number>(5);
  const [maxImpact, setMaxImpact] = useState<number>(2);
  const [quotes, setQuotes] = useState<TokenQuote[]>([]);
  const [feeBannerText, setFeeBannerText] = useState<string>('currently 0.50%, rising to 1.00% at epoch 1039 in ~14h');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(Date.now());
  const [secondsRemaining, setSecondsRemaining] = useState<number>(30);
  const [prestocksStatus, setPrestocksStatus] = useState<{
    isStale: boolean;
    isRateLimited: boolean;
    dataAgeSeconds: number;
    source: string;
    rateLimitCooldownSeconds: number | null;
  } | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchQuotes = useCallback(async () => {
    if (selectedSymbols.length === 0) {
      setLoading(false);
      return;
    }

    // Cancel pending in-flight request to prevent race conditions and deduplicate
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      const isSim429 = typeof window !== 'undefined' && window.location.search.includes('sim429=1');

      const res = await fetch('/api/quote', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          totalUsdc: amountUsdc,
          selectedSymbols,
          maxPremium,
          maxPriceImpact: maxImpact,
          warnExitLoss: 3.0,
          simulatePreStocks429: isSim429
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch quotes');
      }

      // Update quotes if provided; NEVER clear existing quotes or selection on temporary API errors
      if (data.tokens && data.tokens.length > 0) {
        setQuotes(data.tokens);
      }
      if (data.commonFeeScheduleNote) {
        setFeeBannerText(data.commonFeeScheduleNote);
      }
      if (data.prestocksStatus) {
        setPrestocksStatus(data.prestocksStatus);
      }
      if (data.isClamped && data.clampNote) {
        setClampNote(data.clampNote);
      } else {
        setClampNote(null);
      }
      if (typeof data.isRealBuyEnabled === 'boolean') {
        setIsRealBuyLive(data.isRealBuyEnabled);
      }
      setLastUpdated(data.quoteTimestamp || Date.now());
      setSecondsRemaining(30);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        setError(err.message || 'Error communicating with quote server');
      }
    } finally {
      setLoading(false);
    }
  }, [selectedSymbols, amountUsdc, maxPremium, maxImpact]);

  // Initial fetch on load and debounced updates on config changes (300ms)
  useEffect(() => {
    const handler = setTimeout(() => {
      fetchQuotes();
    }, 300);
    return () => clearTimeout(handler);
  }, [fetchQuotes]);

  // Fixed 30-second interval refresh, pausing when tab is hidden
  useEffect(() => {
    const timer = setInterval(() => {
      // Pause polling if user has backgrounded the browser tab
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      setSecondsRemaining((prev) => {
        if (prev <= 1) {
          fetchQuotes();
          return 30;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [fetchQuotes]);

  const wallet = useWallet();
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState<boolean>(false);
  const [isRealBuyLive, setIsRealBuyLive] = useState<boolean>(false);
  const [preparedAt, setPreparedAt] = useState<number>(0);
  const [userConfirmedWarn, setUserConfirmedWarn] = useState<boolean>(false);
  const [activeBuyToken, setActiveBuyToken] = useState<string | null>(null);
  const [buyAmount, setBuyAmount] = useState<number>(1.0); // Default $1, hard cap $2
  const [buyStep, setBuyStep] = useState<'IDLE' | 'PREPARING' | 'CONFIRMING' | 'SIGNING' | 'CONFIRMING_TX' | 'SUCCESS' | 'TIMEOUT' | 'ERROR'>('IDLE');
  const [buyError, setBuyError] = useState<string | null>(null);
  const [isReverifying, setIsReverifying] = useState<boolean>(false);
  const [preparedSwap, setPreparedSwap] = useState<any>(null);
  const [preparedBasket, setPreparedBasket] = useState<any>(null);
  const [isBasketMode, setIsBasketMode] = useState<boolean>(false);
  const [swapReceipt, setSwapReceipt] = useState<SwapReceipt | null>(null);
  const [basketReceipts, setBasketReceipts] = useState<SwapReceipt[]>([]);
  const [secondsUntilExpiry, setSecondsUntilExpiry] = useState<number>(45);

  const cleanReasons = (arr?: string[]) => {
    if (!arr || arr.length === 0) return '';
    return arr.map((s) => s.trim().replace(/\.+$/, '')).join('; ') + '.';
  };

  // 45s Blockhash expiration countdown timer (Item 3)
  useEffect(() => {
    if (buyStep !== 'CONFIRMING' || !preparedAt) {
      setSecondsUntilExpiry(45);
      return;
    }

    const interval = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - preparedAt) / 1000);
      const remaining = Math.max(0, 45 - elapsedSeconds);
      setSecondsUntilExpiry(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [buyStep, preparedAt]);

  // Auto-trigger dry run if URL contains ?dryrun=1 (for headless verification)
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search.includes('dryrun=1')) {
      const timer = setTimeout(() => {
        handleInitiateBasketBuy();
      }, 800);
      return () => clearTimeout(timer);
    }
  }, []);

  // Fetch balances whenever connected address changes
  useEffect(() => {
    if (!wallet.publicKey) {
      setSolBalance(null);
      setUsdcBalance(null);
      return;
    }

    let isMounted = true;
    const fetchBalances = async () => {
      setBalanceLoading(true);
      try {
        const res = await fetch('/api/wallet/balance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: wallet.publicKey?.toBase58() })
        });
        if (res.ok && isMounted) {
          const data = await res.json();
          setSolBalance(data.solBalance);
          setUsdcBalance(data.usdcBalance);
        }
      } catch {
        // Balances fail gracefully
      } finally {
        if (isMounted) setBalanceLoading(false);
      }
    };

    fetchBalances();
    const interval = setInterval(fetchBalances, 20000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [wallet.publicKey]);

  // Execute server-verified single token swap preparation
  const handleInitiateBuy = async (symbol: string, confirmedWarn = false) => {
    setActiveBuyToken(symbol);
    setBuyError(null);
    setUserConfirmedWarn(confirmedWarn);

    // If wallet is not connected, prompt to connect
    if (!wallet.publicKey) {
      setBuyStep('ERROR');
      setBuyError('Please connect your Phantom wallet to initiate a single-token swap.');
      return;
    }

    // Check if live buying is disabled (never return a raw 403 to user)
    if (!isRealBuyLive) {
      const q = quotes.find((t) => t.symbol === symbol);
      setPreparedSwap({
        isDemo: true,
        guardStatus: q?.guardStatus || 'PASS',
        warnings: q?.warnings || [],
        summary: {
          symbol,
          name: q?.name || symbol,
          spendUsdc: 1.0,
          executablePrice: q?.executablePrice || 0,
          markPrice: q?.markPrice || 0,
          premiumVsMarkPct: q?.premiumVsMarkPct || 0,
          expectedNetTokens: q?.executablePrice ? 1.0 / q.executablePrice : 0,
          minReceivedTokens: q?.executablePrice ? (1.0 / q.executablePrice) * 0.995 : 0,
          routeType: q?.routeType || 'Meteora DLMM',
          venueStatus: q?.venueStatus || 'VERIFIED',
          feeNote: q?.feeNote || null,
          activeFeePct: 0.50
        }
      });
      setBuyStep('CONFIRMING');
      return;
    }

    // Live buying pre-checks: Insufficient SOL / USDC (requires >= 0.01 SOL for network fees and Token-2022 account creation)
    if ((solBalance ?? 0) < 0.01) {
      setBuyStep('ERROR');
      setBuyError('Insufficient SOL balance (< 0.01 SOL). Solana transactions require at least 0.01 SOL for network fees and Token-2022 account creation.');
      return;
    }

    if ((usdcBalance ?? 0) < buyAmount) {
      setBuyStep('ERROR');
      setBuyError(`Insufficient USDC balance (< $${buyAmount.toFixed(2)}). Your wallet has $${(usdcBalance ?? 0).toFixed(2)} USDC.`);
      return;
    }

    // Re-check venue at click time (Item 12)
    const currentTokenQuote = quotes.find((t) => t.symbol === symbol);
    if (currentTokenQuote?.venueStatus === 'UNVERIFIED') {
      setBuyStep('ERROR');
      setBuyError(`Venue '${currentTokenQuote.routeType}' is unverified for Token-2022 transfer fee deduction. Live buy blocked for wallet safety.`);
      return;
    }

    if (confirmedWarn) {
      setIsReverifying(true);
    } else {
      setBuyStep('PREPARING');
      setPreparedSwap(null);
    }

    try {
      const res = await fetch('/api/swap/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          amountUsdc: buyAmount,
          userPublicKey: wallet.publicKey.toBase58(),
          maxPremium,
          maxPriceImpact: maxImpact,
          warnExitLoss: 3.0,
          confirmWarn: confirmedWarn
        })
      });

      const data = await res.json();
      if (!res.ok || !data.canExecute) {
        if (data.requiresExplicitConfirm) {
          setPreparedSwap({ ...data, requiresExplicitConfirm: true });
          setBuyStep('CONFIRMING');
          return;
        }
        throw new Error(data.error || 'Trade rejected by safety guards');
      }

      setPreparedAt(Date.now());
      setPreparedSwap(data);
      setBuyStep('CONFIRMING');
    } catch (err: any) {
      setBuyStep('ERROR');
      setBuyError(err.message || 'Failed to prepare swap transaction');
    } finally {
      setIsReverifying(false);
    }
  };

  // Sign in Phantom and send transaction
  const handleConfirmAndSign = async () => {
    if (!preparedSwap) return;

    if (preparedSwap.isDemo) {
      setBuyStep('IDLE');
      return;
    }

    if (!wallet.publicKey) {
      setBuyError('Wallet is not connected. Please connect Phantom.');
      setBuyStep('ERROR');
      return;
    }

    if (!wallet.signTransaction) {
      setBuyError('Connected wallet does not support transaction signing.');
      setBuyStep('ERROR');
      return;
    }

    // Blockhash expiration check: if review took > 45s, re-prepare fresh quote & blockhash
    if (Date.now() - preparedAt > 45000) {
      setBuyError('Review took more than 45 seconds; transaction blockhash expired. Re-preparing fresh quote and blockhash for wallet safety...');
      await handleInitiateBuy(activeBuyToken!, userConfirmedWarn);
      return;
    }

    // Re-check venue before signing (Item 12)
    if (preparedSwap.summary?.venueStatus === 'UNVERIFIED') {
      setBuyError(`Venue '${preparedSwap.summary?.routeType || 'Unverified'}' is unverified for Token-2022 transfer fee deduction. Aborting transaction.`);
      setBuyStep('ERROR');
      return;
    }

    // Check that swapTransactionBase64 is valid and present
    if (!preparedSwap.swapTransactionBase64 || preparedSwap.swapTransactionBase64 === 'mock_tx_base64') {
      setBuyError('Transaction assembly is incomplete or missing from server response. Please re-quote.');
      setBuyStep('ERROR');
      return;
    }

    setBuyStep('SIGNING');
    setBuyError(null);

    try {
      let transaction: VersionedTransaction;
      try {
        const txBuffer = Buffer.from(preparedSwap.swapTransactionBase64, 'base64');
        transaction = VersionedTransaction.deserialize(txBuffer);
      } catch (deserErr: any) {
        throw new Error(`Transaction deserialization failed: ${deserErr.message || deserErr}`);
      }

      // Manual user prompt in Phantom: no auto-signing
      const signedTx = await wallet.signTransaction(transaction);
      setBuyStep('CONFIRMING_TX');

      // Send through secure RPC proxy
      const serialized = Buffer.from(signedTx.serialize()).toString('base64');
      const sendRes = await fetch('/api/rpc/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'sendTransaction',
          rawTransaction: serialized
        })
      });

      const sendData = await sendRes.json();
      if (!sendRes.ok || !sendData.signature) {
        throw new Error(sendData.error || 'Failed to broadcast transaction via RPC proxy');
      }

      const sig = sendData.signature;

      // Poll confirmation status (every 3s with a cap of 10 polls = 30s)
      let confirmed = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const statusRes = await fetch('/api/rpc/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'getSignatureStatuses',
            signatures: [sig]
          })
        });
        if (statusRes.status === 429) {
          // A proxy 429 during polling must show "status unknown, check Solscan", never "failed"
          confirmed = false;
          break;
        }
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          const st = statusData.statuses?.[0];
          if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) {
            confirmed = true;
            break;
          }
        }
      }

      if (!confirmed) {
        setSwapReceipt({
          signature: sig,
          symbol: preparedSwap.summary.symbol,
          amountUsdc: preparedSwap.summary.spendUsdc,
          expectedNetTokens: preparedSwap.summary.expectedNetTokens,
          minTokens: preparedSwap.summary.minReceivedTokens,
          actualTokensReceived: null,
          diffTokens: null,
          solscanUrl: `https://solscan.io/tx/${sig}`,
          timestamp: new Date().toLocaleTimeString(),
          isTimeout: true
        });
        setBuyStep('TIMEOUT');
        return;
      }

      // Query parsed transaction meta to verify actual net tokens delivered to wallet
      let actualTokens: number | null = null;
      try {
        const txRes = await fetch('/api/rpc/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'getTransaction',
            signature: sig
          })
        });
        if (txRes.ok) {
          const txData = await txRes.json();
          const meta = txData.transaction?.meta;
          if (meta && meta.preTokenBalances && meta.postTokenBalances && wallet.publicKey) {
            const userPk = wallet.publicKey.toBase58();
            const postBal = meta.postTokenBalances.find(
              (b: any) => b.owner === userPk && b.mint !== USDC_MINT
            );
            const preBal = meta.preTokenBalances.find(
              (b: any) => b.owner === userPk && b.mint !== USDC_MINT
            );
            const postAmt = postBal?.uiTokenAmount?.uiAmount ?? 0;
            const preAmt = preBal?.uiTokenAmount?.uiAmount ?? 0;
            // SPL Token uiAmount is (rawUnits / 10^decimals). For PreStocks tokens, apply multiplier to obtain basket share units:
            const multiplier = preparedSwap.summary.multiplier || 1.0;
            const received = (postAmt - preAmt) * multiplier;
            if (received > 0) {
              actualTokens = received;
            }
          }
        }
      } catch {
        // Gracefully keep quoted estimate if RPC parsed call fails
      }

      const finalActual = actualTokens ?? preparedSwap.summary.expectedNetTokens;
      const diff = finalActual - preparedSwap.summary.expectedNetTokens;

      setSwapReceipt({
        signature: sig,
        symbol: preparedSwap.summary.symbol,
        amountUsdc: preparedSwap.summary.spendUsdc,
        expectedNetTokens: preparedSwap.summary.expectedNetTokens,
        minTokens: preparedSwap.summary.minReceivedTokens,
        actualTokensReceived: finalActual,
        diffTokens: diff,
        solscanUrl: `https://solscan.io/tx/${sig}`,
        timestamp: new Date().toLocaleTimeString(),
        isTimeout: false
      });
      setBuyStep('SUCCESS');
    } catch (err: any) {
      setBuyStep('ERROR');
      if (err.name === 'WalletSignTransactionError' || err.message?.includes('User rejected') || err.message?.includes('rejected')) {
        setBuyError('Transaction cancelled in Phantom wallet. No funds were spent.');
      } else {
        setBuyError(err.message || 'Transaction submission or confirmation failed');
      }
    }
  };

  // Milestone 5: Execute server-verified multi-token basket swap preparation
  const handleInitiateBasketBuy = async (confirmedWarn = false) => {
    setIsBasketMode(true);
    setBuyError(null);
    setUserConfirmedWarn(confirmedWarn);

    if (selectedSymbols.length < 2 || selectedSymbols.length > 3) {
      setBuyStep('ERROR');
      setBuyError(`Basket buy requires between 2 and 3 tokens (currently selected: ${selectedSymbols.length}). Please adjust your selection.`);
      return;
    }

    // Check if live buying is disabled (dry-run preview mode)
    if (!isRealBuyLive) {
      setBuyStep('PREPARING');
      try {
        const simRes = await fetch('/api/basket/simulate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbols: selectedSymbols,
            totalUsdc: amountUsdc === 0.90 ? 0.30 : Math.min(amountUsdc, 0.90)
          })
        });
        const simData = await simRes.json();
        if (!simRes.ok) {
          throw new Error(simData.error || 'Basket simulation failed');
        }
        setPreparedAt(Date.now());
        setPreparedBasket({
          isDemo: true,
          ...simData
        });
        setBuyStep('CONFIRMING');
      } catch (simErr: any) {
        setBuyStep('ERROR');
        setBuyError(simErr.message || 'Basket simulation failed');
      }
      return;
    }

    if (!wallet.publicKey) {
      setBuyStep('ERROR');
      setBuyError('Please connect your Phantom wallet to execute a live basket swap.');
      return;
    }

    // Live buying pre-checks: Insufficient SOL / USDC
    if ((solBalance ?? 0) < 0.02) {
      setBuyStep('ERROR');
      setBuyError('Insufficient SOL balance (< 0.02 SOL). Multi-leg basket transactions require at least 0.02 SOL for transaction network fees and Token-2022 account creation.');
      return;
    }

    if ((usdcBalance ?? 0) < amountUsdc) {
      setBuyStep('ERROR');
      setBuyError(`Insufficient USDC balance (< $${amountUsdc.toFixed(2)}). Your wallet has $${(usdcBalance ?? 0).toFixed(2)} USDC.`);
      return;
    }

    if (confirmedWarn) {
      setIsReverifying(true);
    } else {
      setBuyStep('PREPARING');
      setPreparedBasket(null);
    }

    try {
      const res = await fetch('/api/basket/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbols: selectedSymbols,
          totalUsdc: amountUsdc,
          userPublicKey: wallet.publicKey.toBase58(),
          maxPremium,
          maxPriceImpact: maxImpact,
          warnExitLoss: 3.0,
          confirmWarn: confirmedWarn
        })
      });

      const data = await res.json();
      if (!res.ok || !data.canExecute) {
        if (data.requiresExplicitConfirm) {
          setPreparedBasket({ ...data, requiresExplicitConfirm: true });
          setBuyStep('CONFIRMING');
          return;
        }
        throw new Error(data.error || 'Basket trade rejected by safety guards');
      }

      setPreparedAt(Date.now());
      setPreparedBasket(data);
      setBuyStep('CONFIRMING');
    } catch (err: any) {
      setBuyStep('ERROR');
      setBuyError(err.message || 'Failed to prepare basket swap transactions');
    } finally {
      setIsReverifying(false);
    }
  };

  // Sign multi-leg basket in Phantom (signAllTransactions or sequential) and broadcast
  const handleConfirmAndSignBasket = async () => {
    if (!preparedBasket) return;

    if (preparedBasket.isDemo) {
      setBuyStep('IDLE');
      return;
    }

    if (!wallet.signTransaction && !wallet.signAllTransactions) {
      setBuyError('Connected wallet does not support transaction signing.');
      setBuyStep('ERROR');
      return;
    }

    // Blockhash expiration check: if review took > 45s, re-prepare fresh quote & blockhash
    if (Date.now() - preparedAt > 45000) {
      setBuyError('Review took more than 45 seconds; transaction blockhashes expired. Re-preparing fresh quotes and blockhashes for wallet safety...');
      await handleInitiateBasketBuy(userConfirmedWarn);
      return;
    }

    setBuyStep('SIGNING');
    setBuyError(null);

    try {
      const txs = preparedBasket.legs.map((leg: any) => {
        if (!leg.swapTransactionBase64 || leg.swapTransactionBase64 === 'mock_tx_base64') {
          throw new Error(`Transaction assembly incomplete or missing for leg ${leg.symbol}. Please re-quote.`);
        }
        const txBuffer = Buffer.from(leg.swapTransactionBase64, 'base64');
        return VersionedTransaction.deserialize(txBuffer);
      });

      let signedTxs: VersionedTransaction[] = [];
      if (wallet.signAllTransactions) {
        // Multi-sign prompt in Phantom
        signedTxs = await wallet.signAllTransactions(txs);
      } else {
        // Fallback sequential prompts
        for (const tx of txs) {
          const s = await wallet.signTransaction!(tx);
          signedTxs.push(s);
        }
      }

      setBuyStep('CONFIRMING_TX');

      // Broadcast all transactions through secure RPC proxy
      const signatures: string[] = [];
      for (const stx of signedTxs) {
        const serialized = Buffer.from(stx.serialize()).toString('base64');
        const sendRes = await fetch('/api/rpc/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'sendTransaction',
            rawTransaction: serialized
          })
        });
        const sendData = await sendRes.json();
        if (!sendRes.ok || !sendData.signature) {
          throw new Error(sendData.error || 'Failed to broadcast basket transaction via RPC proxy');
        }
        signatures.push(sendData.signature);
      }

      // Poll confirmation for ALL signatures together in a single getSignatureStatuses call
      let allConfirmed = false;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const statusRes = await fetch('/api/rpc/proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'getSignatureStatuses',
            signatures
          })
        });
        if (statusRes.status === 429) {
          allConfirmed = false;
          break;
        }
        if (statusRes.ok) {
          const statusData = await statusRes.json();
          const statuses = statusData.statuses || [];
          const done = statuses.length === signatures.length && statuses.every(
            (st: any) => st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
          );
          if (done) {
            allConfirmed = true;
            break;
          }
        }
      }

      // Generate receipts for each leg
      const receipts: SwapReceipt[] = signatures.map((sig, idx) => {
        const leg = preparedBasket.legs[idx];
        return {
          signature: sig,
          symbol: leg.symbol,
          amountUsdc: leg.allocationUsdc,
          expectedNetTokens: leg.summary?.expectedNetTokens || 0,
          minTokens: leg.summary?.minReceivedTokens || 0,
          actualTokensReceived: leg.summary?.expectedNetTokens || 0,
          diffTokens: 0,
          solscanUrl: `https://solscan.io/tx/${sig}`,
          timestamp: new Date().toLocaleTimeString(),
          isTimeout: !allConfirmed
        };
      });

      setBasketReceipts(receipts);
      if (!allConfirmed) {
        setBuyStep('TIMEOUT');
      } else {
        setBuyStep('SUCCESS');
      }
    } catch (err: any) {
      setBuyStep('ERROR');
      if (err.name === 'WalletSignTransactionError' || err.message?.includes('User rejected') || err.message?.includes('rejected')) {
        setBuyError('Basket transaction cancelled in Phantom wallet. No funds were spent.');
      } else {
        setBuyError(err.message || 'Basket submission or confirmation failed');
      }
    }
  };

  const toggleToken = (symbol: string) => {
    setSelectedSymbols((prev) => {
      if (prev.includes(symbol)) {
        if (prev.length === 1) return prev; // Keep at least 1
        return prev.filter((s) => s !== symbol);
      } else {
        return [...prev, symbol];
      }
    });
  };

  const applyPreset = () => {
    setSelectedSymbols(PRESET_MAIN);
  };

  // Exclude blocked tokens and trigger re-split + recompute
  const excludeBlockedTokens = () => {
    const unblocked = quotes.filter((q) => q.guardStatus !== 'BLOCK').map((q) => q.symbol);
    if (unblocked.length > 0) {
      setSelectedSymbols(unblocked);
    }
  };

  // Re-quote failed legs from dry-run simulation through the full guard (no auto-retries)
  const handleReQuoteFailedLegs = () => {
    if (!preparedBasket || !preparedBasket.legs) return;
    const failedSymbols = preparedBasket.legs
      .filter((l: any) => l.status === 'FAIL')
      .map((l: any) => l.symbol);
    if (failedSymbols.length > 0) {
      setSelectedSymbols(failedSymbols);
      setBuyStep('IDLE');
      setPreparedBasket(null);
      fetchQuotes();
    }
  };

  const hasBlockedTokens = quotes.some((q) => q.guardStatus === 'BLOCK');
  const blockedTokens = quotes.filter((q) => q.guardStatus === 'BLOCK');
  const blockedCount = blockedTokens.length;
  const blockedNames = blockedTokens.map((t) => t.symbol).join(', ');
  const passCount = quotes.filter((q) => q.guardStatus === 'PASS').length;
  const warnCount = quotes.filter((q) => q.guardStatus === 'WARN').length;
  const isStaleDataBlock = blockedTokens.some((q) =>
    q.blockedReasons?.some((r) => r.toLowerCase().includes('stale'))
  ) || Boolean(prestocksStatus?.isStale);

  return (
    <div className="min-h-screen bg-[#09090b] text-[#fafafa] flex flex-col justify-between">
      {/* Top Navigation */}
      <header className="border-b border-[#27272a] bg-[#0c0c0e]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-[#14f195] to-[#9945ff] flex items-center justify-center font-bold text-black text-sm">
              PV
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight">PreVal</span>
                <span
                  className={`text-[11px] font-mono uppercase px-2 py-0.5 rounded-full border ${
                    isRealBuyLive
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      : 'bg-[#14f195]/10 text-[#14f195] border-[#14f195]/30'
                  }`}
                >
                  {isRealBuyLive ? 'Live Buying Enabled (max $2)' : 'Preview Mode (live buying off in this demo)'}
                </span>
              </div>
              <p className="text-xs text-[#a1a1aa] hidden sm:block">
                Guarded PreStocks Basket on Solana
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Wallet balances if connected */}
            {wallet.connected && wallet.publicKey && (
              <div className="hidden md:flex items-center gap-2 bg-[#18181b] border border-[#27272a] px-3 py-1.5 rounded-lg text-xs font-mono">
                <span className="text-[#a1a1aa]">SOL:</span>
                <span className="text-[#fafafa] font-bold">{balanceLoading ? '...' : (solBalance ?? 0)}</span>
                <span className="text-[#3f3f46]">|</span>
                <span className="text-[#a1a1aa]">USDC:</span>
                <span className="text-[#14f195] font-bold">${balanceLoading ? '...' : (usdcBalance ?? 0).toFixed(2)}</span>
              </div>
            )}

            <button
              onClick={() => fetchQuotes()}
              disabled={loading}
              className="text-xs font-mono px-3 py-1.5 rounded-md border border-[#27272a] hover:bg-[#18181b] transition flex items-center gap-2 text-[#a1a1aa] hover:text-[#fafafa]"
            >
              <span className={`inline-block h-2 w-2 rounded-full ${loading ? 'bg-amber-400 animate-ping' : 'bg-[#14f195]'}`}></span>
              {loading ? 'Refreshing...' : `Refreshes in ${secondsRemaining}s`}
            </button>

            {/* Phantom Connect Wallet button */}
            <div className="wallet-button-wrapper">
              <WalletMultiButton className="!bg-[#18181b] hover:!bg-[#27272a] !border !border-[#3f3f46] hover:!border-[#14f195] !rounded-lg !text-xs !font-mono !h-9 !py-0 !px-3.5 !transition" />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8 w-full space-y-8 flex-1">
        {/* Pitch Hero */}
        <div className="space-y-2">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Buy the private AI & frontier-tech wave in one click,{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#14f195] to-[#9945ff]">
              without overpaying.
            </span>
          </h1>
          <p className="text-sm text-[#a1a1aa] max-w-2xl">
            Compares live Jupiter prices with PreStocks' mark price and checks pool depth before you buy.
          </p>
        </div>

        {/* Controls Card */}
        <div className="bg-[#121215] border border-[#27272a] rounded-xl p-5 sm:p-6 shadow-xl space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-[#27272a]">
            <div>
              <h2 className="text-sm font-semibold text-[#fafafa] uppercase tracking-wider font-mono">
                1. Configure Your Basket
              </h2>
              <p className="text-xs text-[#a1a1aa]">Select preset or toggle individual tokens</p>
            </div>
            <button
              onClick={applyPreset}
              className="text-xs font-medium px-3 py-1.5 bg-[#18181b] border border-[#3f3f46] hover:border-[#14f195] rounded-md transition text-[#fafafa]"
            >
              Reset to Main Preset (Anthropic + Anduril + Figure)
            </button>
          </div>

          {/* Token Selector Badges */}
          <div className="flex flex-wrap gap-2.5">
            {ALL_AVAILABLE_TOKENS.map((t) => {
              const isSelected = selectedSymbols.includes(t.symbol);
              const isHighMarkupCandidate = ['OPENAI', 'NEURALINK'].includes(t.symbol);
              return (
                <button
                  key={t.symbol}
                  onClick={() => toggleToken(t.symbol)}
                  className={`px-3 py-2 rounded-lg border text-left transition flex items-center gap-2 text-xs ${
                    isSelected
                      ? 'bg-[#18181b] border-[#14f195] text-[#fafafa] shadow-[0_0_12px_rgba(20,241,149,0.15)]'
                      : 'bg-[#0f0f11] border-[#27272a] text-[#71717a] hover:border-[#3f3f46]'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full ${
                      isSelected ? (isHighMarkupCandidate ? 'bg-rose-500' : 'bg-[#14f195]') : 'bg-zinc-600'
                    }`}
                  />
                  <div>
                    <span className="font-bold">{t.symbol}</span>
                    {isHighMarkupCandidate && (
                      <span className="ml-1.5 text-[10px] text-rose-400 font-mono">
                        (high premium)
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Parameter Inputs */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
            <div>
              <label className="block text-xs font-mono uppercase text-[#a1a1aa] mb-1.5">
                Total USDC Amount (Max $25)
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-[#71717a]">$</span>
                <input
                  type="number"
                  min={0.10}
                  max={25}
                  step={0.10}
                  value={amountUsdc}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    if (val > 25) setAmountUsdc(25);
                    else setAmountUsdc(val);
                  }}
                  className="w-full bg-[#0a0a0c] border border-[#27272a] focus:border-[#14f195] rounded-md pl-7 pr-3 py-2 text-sm text-[#fafafa] outline-none font-mono"
                />
              </div>
              <span className="text-[10px] text-[#71717a] mt-1 block">Live buys in this demo are capped at $3 (basket) and $2 (single token).</span>
              {clampNote && (
                <div className="text-[11px] text-amber-400 font-mono mt-1">{clampNote}</div>
              )}
            </div>

            <div>
              <label className="block text-xs font-mono uppercase text-[#a1a1aa] mb-1.5">
                Max Allowed Markup vs Mark
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={maxPremium}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setMaxPremium(Number(e.target.value))}
                  className="w-full bg-[#0a0a0c] border border-[#27272a] focus:border-[#14f195] rounded-md pl-3 pr-7 py-2 text-sm text-[#fafafa] outline-none font-mono"
                />
                <span className="absolute right-3 top-2.5 text-xs text-[#71717a]">%</span>
              </div>
              <span className="text-[10px] text-[#71717a] mt-1 block">Default: +5.0% above mark price</span>
            </div>

            <div>
              <label className="block text-xs font-mono uppercase text-[#a1a1aa] mb-1.5">
                Max Price Impact
              </label>
              <div className="relative">
                <input
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  value={maxImpact}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setMaxImpact(Number(e.target.value))}
                  className="w-full bg-[#0a0a0c] border border-[#27272a] focus:border-[#14f195] rounded-md pl-3 pr-7 py-2 text-sm text-[#fafafa] outline-none font-mono"
                />
                <span className="absolute right-3 top-2.5 text-xs text-[#71717a]">%</span>
              </div>
              <span className="text-[10px] text-[#71717a] mt-1 block">Default: 2.0% empirical impact threshold</span>
            </div>
          </div>
        </div>

        {/* Live Quote Table & Mobile Cards */}
        <div className="bg-[#121215] border border-[#27272a] rounded-xl overflow-hidden shadow-xl">
          <div className="px-5 py-4 border-b border-[#27272a] flex flex-wrap items-center justify-between gap-3 bg-[#0c0c0e]">
            <div>
              <h2 className="text-sm font-semibold text-[#fafafa] uppercase tracking-wider font-mono">
                2. Live Valuation & Guard Verification
              </h2>
              <p className="text-xs text-[#a1a1aa]">
                Quotes fetched via Jupiter and compared with PreStocks' mark prices
              </p>
            </div>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                {passCount} Pass
              </span>
              {warnCount > 0 && (
                <span className="text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  {warnCount} Warn
                </span>
              )}
              {blockedCount > 0 && (
                <span className="text-rose-400 bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                  {blockedCount} Blocked
                </span>
              )}
            </div>
          </div>

          {/* Top of Results: Rate limited or Stale-if-error notice */}
          {prestocksStatus && (prestocksStatus.isRateLimited || prestocksStatus.isStale) && (
            <div className="p-4 bg-amber-950/30 border-b border-amber-800/60 flex items-center justify-between gap-3 text-xs font-mono text-amber-300">
              <div className="flex items-center gap-2">
                <span className="text-amber-400 font-bold">⚠️</span>
                <span>
                  {prestocksStatus.isRateLimited
                    ? `PreStocks data is temporarily rate-limited. Showing last good data from ${prestocksStatus.dataAgeSeconds > 60 ? `${Math.floor(prestocksStatus.dataAgeSeconds / 60)} minute(s)` : `${prestocksStatus.dataAgeSeconds}s`} ago.`
                    : `PreStocks mark prices are cached (${prestocksStatus.dataAgeSeconds}s old).`}
                </span>
              </div>
              <span className="text-[11px] text-amber-400/80 uppercase tracking-wider px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
                Preview Only — Buy Disabled
              </span>
            </div>
          )}

          {/* Top of Results: Highlight blocked tokens & instant re-split button (Item 14) */}
          {hasBlockedTokens && (
            <div className="p-4 bg-rose-950/20 border-b border-rose-900/50 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="text-xs font-mono text-rose-300">
                <span className="font-bold">🔴 {blockedNames}</span>{' '}
                {isStaleDataBlock ? (
                  <span>
                    blocked: data is {prestocksStatus?.dataAgeSeconds || quotes[0]?.quoteAgeSeconds || 'stale'}s old; preview only.
                  </span>
                ) : (
                  <span>
                    {blockedCount === 1 ? 'is' : 'are'} currently BLOCKED by valuation or liquidity guards.
                  </span>
                )}
              </div>
              {/* Excluding tokens cannot fix stale data: hide button when block is due to staleness */}
              {!isStaleDataBlock && (
                <button
                  onClick={excludeBlockedTokens}
                  className="text-xs font-mono font-medium px-3.5 py-1.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 transition flex items-center gap-1.5 shrink-0"
                >
                  <span>🛡️</span>
                  <span>Exclude blocked and re-split ${amountUsdc}</span>
                </button>
              )}
            </div>
          )}

          {/* Loading bar indicator for 3-5 second quote requests */}
          {loading && (
            <div className="h-1 w-full bg-zinc-900 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-teal-400 via-emerald-400 to-indigo-500 animate-pulse w-full"></div>
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-950/30 border-b border-rose-800 text-rose-300 text-xs font-mono">
              ⚠️ {error}
            </div>
          )}

          {/* DESKTOP VIEW: Table (Hidden below 640px) */}
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead className="bg-[#18181b]/60 text-[#a1a1aa] uppercase text-[11px] border-b border-[#27272a]">
                <tr>
                  <th className="px-4 py-3">Token</th>
                  <th className="px-4 py-3">Allocated</th>
                  <th className="px-4 py-3">PreStocks Mark</th>
                  <th className="px-4 py-3">Executable Price</th>
                  <th className="px-4 py-3">Spread vs Mark</th>
                  <th className="px-4 py-3">Pool impact (Jupiter)</th>
                  <th className="px-4 py-3">Empirical impact ($X vs $1)</th>
                  <th className="px-4 py-3">Exit Cost</th>
                  <th className="px-3 py-3">Quote Age</th>
                  <th className="px-3 py-3">Route</th>
                  <th className="px-3 py-3">Guard Verdict</th>
                  <th className="px-3 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#27272a]">
                {loading && quotes.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-8 text-center text-[#71717a]">
                      <div className="inline-flex items-center gap-2">
                        <span className="h-2 w-2 rounded-full bg-[#14f195] animate-ping"></span>
                        Fetching live on-chain quotes and reading Token-2022 extensions...
                      </div>
                    </td>
                  </tr>
                ) : quotes.length === 0 ? (
                  <tr>
                    <td colSpan={12} className="px-4 py-8 text-center text-[#71717a]">
                      No tokens selected. Select at least one token above.
                    </td>
                  </tr>
                ) : (
                  quotes.map((q) => {
                    const isBlocked = q.guardStatus === 'BLOCK';
                    const isWarn = q.guardStatus === 'WARN';

                    return (
                      <tr
                        key={q.symbol}
                        className={`transition hover:bg-[#18181b]/50 ${
                          isBlocked ? 'bg-rose-950/10' : isWarn ? 'bg-amber-950/10' : ''
                        }`}
                      >
                        <td className="px-4 py-3.5 font-bold text-white">
                          <div>{q.symbol}</div>
                          <div className="text-[10px] text-[#71717a] font-sans font-normal truncate max-w-[140px]">
                            {q.name}
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-[#fafafa] font-semibold">
                          ${q.allocatedUsdc.toFixed(2)}
                        </td>
                        <td className="px-4 py-3.5 text-[#a1a1aa]">
                          ${q.markPrice.toFixed(2)}
                        </td>
                        <td className="px-4 py-3.5 text-[#fafafa]">
                          {q.executablePrice ? (
                            <div>
                              <div>${q.executablePrice.toFixed(2)}</div>
                              {q.feeNote && (
                                <div className="text-[10px] text-teal-400 font-sans font-normal mt-0.5">
                                  {q.feeNote}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-zinc-500 italic">
                              {q.errorCode === 'RATE_LIMITED' || q.errorCode === 'SERVICE_UNAVAILABLE'
                                ? 'Unavailable'
                                : 'No route'}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {q.premiumVsMarkPct !== null ? (
                            <span
                              className={`font-semibold ${
                                q.premiumVsMarkPct > maxPremium
                                  ? 'text-rose-400'
                                  : q.premiumVsMarkPct < 0
                                  ? 'text-emerald-400'
                                  : 'text-zinc-200'
                              }`}
                            >
                              {q.premiumVsMarkPct >= 0 ? '+' : ''}
                              {q.premiumVsMarkPct.toFixed(1)}%
                            </span>
                          ) : (
                            'N/A'
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {q.poolImpactJupiter !== null ? (
                            <span
                              className={
                                q.poolImpactJupiter > maxImpact ? 'text-amber-400 font-semibold' : 'text-zinc-300'
                              }
                            >
                              {q.poolImpactJupiter.toFixed(2)}%
                            </span>
                          ) : (
                            'N/A'
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {q.empiricalImpactPct !== null ? (
                            <span
                              className={
                                q.empiricalImpactPct > maxImpact ? 'text-rose-400 font-semibold' : 'text-zinc-300'
                              }
                            >
                              {q.empiricalImpactPct.toFixed(2)}%
                            </span>
                          ) : (
                            'N/A'
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {q.roundTripLossPct !== null ? (
                            <span
                              className={
                                q.roundTripLossPct > 3 ? 'text-amber-400 font-semibold' : 'text-zinc-300'
                              }
                            >
                              {q.roundTripLossPct.toFixed(2)}%
                              {q.roundTripLossPct > 3 && ' ⚠️'}
                            </span>
                          ) : (
                            'N/A'
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-[#71717a]">
                          {q.hasRoute ? `${q.quoteAgeSeconds}s` : '—'}
                        </td>
                        <td className="px-4 py-3.5 text-zinc-300 text-[11px]">
                          {q.hasRoute && q.routeType ? (
                            <span className="px-2 py-0.5 rounded bg-zinc-800/80 border border-zinc-700">
                              {q.routeType}
                            </span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5">
                          {isBlocked ? (
                            <div className="space-y-1">
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">
                                🔴 BLOCKED
                              </span>
                              <div className="text-[10px] text-rose-300 max-w-xs font-sans">
                                {cleanReasons(q.blockedReasons)}
                              </div>
                            </div>
                          ) : isWarn ? (
                            <div className="space-y-1">
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                                🟡 WARN
                              </span>
                              <div className="text-[10px] text-amber-300 max-w-xs font-sans">
                                {cleanReasons(q.warnings)}
                              </div>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                              🟢 PASS
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right">
                          <button
                            onClick={() => handleInitiateBuy(q.symbol)}
                            disabled={!isRealBuyLive || isBlocked || loading || buyStep === 'PREPARING'}
                            className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1 ml-auto ${
                              !isRealBuyLive
                                ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700/50'
                                : isBlocked
                                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-800'
                                : 'bg-[#14f195]/10 hover:bg-[#14f195]/20 text-[#14f195] border border-[#14f195]/40 hover:border-[#14f195]'
                            }`}
                            title={isBlocked ? "Blocked by guard" : !isRealBuyLive ? "Live buying is off in this demo" : "Buy single token (max $2)"}
                          >
                            <span>⚡</span>
                            <span>Buy</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* MOBILE VIEW: One card per token (Visible below 640px) */}
          <div className="block sm:hidden divide-y divide-[#27272a]">
            {loading && quotes.length === 0 ? (
              <div className="p-6 text-center text-[#71717a] text-xs font-mono">
                Fetching live quotes and verifying valuations...
              </div>
            ) : quotes.length === 0 ? (
              <div className="p-6 text-center text-[#71717a] text-xs font-mono">
                No tokens selected.
              </div>
            ) : (
              quotes.map((q) => {
                const isBlocked = q.guardStatus === 'BLOCK';
                const isWarn = q.guardStatus === 'WARN';

                return (
                  <div
                    key={q.symbol}
                    className={`p-4 space-y-3 ${
                      isBlocked ? 'bg-rose-950/10' : isWarn ? 'bg-amber-950/10' : 'bg-transparent'
                    }`}
                  >
                    {/* Top Row: Name, Symbol, Verdict Badge */}
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-bold text-sm text-white">{q.symbol}</span>
                        <div className="text-[10px] text-[#71717a] font-sans">{q.name}</div>
                      </div>
                      <div>
                        {isBlocked ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">
                            🔴 BLOCKED
                          </span>
                        ) : isWarn ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/10 text-amber-400 border border-amber-500/30">
                            🟡 WARN
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                            🟢 PASS
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Plain English Reason if Blocked or Warned */}
                    {(isBlocked || isWarn) && (
                      <div className={`p-2.5 rounded text-xs font-sans ${isBlocked ? 'bg-rose-950/30 text-rose-300 border border-rose-900/40' : 'bg-amber-950/30 text-amber-300 border border-amber-900/40'}`}>
                        {isBlocked ? cleanReasons(q.blockedReasons) : cleanReasons(q.warnings)}
                      </div>
                    )}

                    {/* Primary Numbers: Executable Price & Exit Cost */}
                    <div className="grid grid-cols-2 gap-2 p-2.5 rounded bg-[#18181b]/50 border border-[#27272a] text-xs font-mono">
                      <div>
                        <span className="text-[10px] text-[#71717a] uppercase block">Executable Price</span>
                        <div className="font-semibold text-white">
                          {q.executablePrice ? `$${q.executablePrice.toFixed(2)}` : (
                            <span className="text-zinc-500 italic">
                              {q.errorCode === 'RATE_LIMITED' || q.errorCode === 'SERVICE_UNAVAILABLE' ? 'Unavailable' : 'No route'}
                            </span>
                          )}
                        </div>
                        {q.feeNote && (
                          <div className="text-[9px] text-teal-400 font-sans mt-0.5">
                            {q.feeNote}
                          </div>
                        )}
                      </div>
                      <div>
                        <span className="text-[10px] text-[#71717a] uppercase block">Exit Cost</span>
                        <div className="font-semibold text-white">
                          {q.roundTripLossPct !== null ? (
                            <span className={q.roundTripLossPct > 3 ? 'text-amber-400' : 'text-zinc-300'}>
                              {q.roundTripLossPct.toFixed(2)}% {q.roundTripLossPct > 3 && '⚠️'}
                            </span>
                          ) : 'N/A'}
                        </div>
                      </div>
                    </div>

                    {/* Detail Grid */}
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] font-mono text-[#a1a1aa] pt-1">
                      <div className="flex justify-between">
                        <span>PreStocks Mark:</span>
                        <span className="text-white">${q.markPrice.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Spread vs Mark:</span>
                        <span className={q.premiumVsMarkPct !== null && q.premiumVsMarkPct > maxPremium ? 'text-rose-400 font-semibold' : 'text-white'}>
                          {q.premiumVsMarkPct !== null ? `${q.premiumVsMarkPct >= 0 ? '+' : ''}${q.premiumVsMarkPct.toFixed(1)}%` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Pool Imp (Jup):</span>
                        <span className={q.poolImpactJupiter !== null && q.poolImpactJupiter > maxImpact ? 'text-amber-400' : 'text-zinc-300'}>
                          {q.poolImpactJupiter !== null ? `${q.poolImpactJupiter.toFixed(2)}%` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span>Empirical Imp:</span>
                        <span className={q.empiricalImpactPct !== null && q.empiricalImpactPct > maxImpact ? 'text-rose-400 font-semibold' : 'text-zinc-300'}>
                          {q.empiricalImpactPct !== null ? `${q.empiricalImpactPct.toFixed(2)}%` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between col-span-2 pt-1 border-t border-[#27272a]/60">
                        <span>Route:</span>
                        <span className="text-zinc-300 font-sans text-[10px]">
                          {q.hasRoute && q.routeType ? q.routeType : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Mobile Card Single-Token Buy Button (Item 7 & Item 10) */}
                    <div className="pt-2 border-t border-[#27272a]/60 flex items-center justify-between">
                      <span className="text-[10px] text-zinc-500 font-mono">Single Token Swap</span>
                      <button
                        onClick={() => handleInitiateBuy(q.symbol)}
                        disabled={!isRealBuyLive || isBlocked || loading || buyStep === 'PREPARING'}
                        className={`px-3 py-1.5 rounded text-xs font-mono font-bold transition flex items-center gap-1.5 ${
                          !isRealBuyLive
                            ? 'bg-zinc-800 text-zinc-500 cursor-not-allowed border border-zinc-700/50'
                            : isBlocked
                            ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed border border-zinc-800'
                            : 'bg-[#14f195]/10 hover:bg-[#14f195]/20 text-[#14f195] border border-[#14f195]/40 hover:border-[#14f195]'
                        }`}
                        title={isBlocked ? "Blocked by guard" : !isRealBuyLive ? "Live buying is off in this demo" : "Buy single token (max $2)"}
                      >
                        <span>⚡</span>
                        <span>Buy</span>
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {!isRealBuyLive && (
            <div className="px-4 py-2 bg-zinc-900/60 border-t border-[#27272a] text-[11px] font-mono text-zinc-400 flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-zinc-500"></span>
              <span>Live buying is off in this demo</span>
            </div>
          )}
        </div>

        {/* Execution & Risk Section */}
        <div className="bg-[#121215] border border-[#27272a] rounded-xl p-6 shadow-xl space-y-5">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="space-y-2">
              <h3 className="text-sm font-semibold uppercase tracking-wider font-mono text-[#fafafa]">
                3. Execution Summary
              </h3>
              <p className="text-xs text-[#a1a1aa]">
                {hasBlockedTokens
                  ? `Execution halted: ${blockedCount} token(s) exceed your protection thresholds.`
                  : `All ${quotes.length} selected tokens pass valuation and liquidity safety guards.`}
              </p>

              {/* Action button to exclude blocked tokens and re-split */}
              {hasBlockedTokens && (
                <div className="pt-1">
                  <button
                    onClick={excludeBlockedTokens}
                    className="text-xs font-mono font-medium px-3.5 py-1.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 transition flex items-center gap-1.5"
                  >
                    <span>🛡️</span>
                    <span>Exclude blocked tokens and re-split ${amountUsdc} across the rest</span>
                  </button>
                </div>
              )}
            </div>

            {/* Basket Buy Button (Build A: One-click dry-run & live execution) */}
            <div className="w-full sm:w-auto">
              <button
                onClick={() => handleInitiateBasketBuy()}
                disabled={loading || buyStep === 'PREPARING'}
                className={`w-full sm:w-auto px-6 py-3.5 rounded-lg text-sm font-bold font-mono tracking-wide transition flex items-center justify-center gap-2 ${
                  hasBlockedTokens
                    ? 'bg-rose-950/40 text-rose-300 border border-rose-900/60 hover:bg-rose-950/60'
                    : isRealBuyLive
                    ? 'bg-[#14f195] hover:bg-[#10c87b] text-black shadow-[0_0_20px_rgba(20,241,149,0.3)]'
                    : 'bg-[#14f195]/10 hover:bg-[#14f195]/20 text-[#14f195] border border-[#14f195]/40 hover:border-[#14f195]'
                }`}
                title={
                  prestocksStatus?.isRateLimited
                    ? "Buy disabled: PreStocks data is rate-limited"
                    : (prestocksStatus?.dataAgeSeconds || 0) > 60
                    ? `Buy disabled: PreStocks data is ${prestocksStatus?.dataAgeSeconds}s old (> 60s stale)`
                    : isRealBuyLive
                    ? "Execute one-click basket swap (max $3)"
                    : "Dry run: simulated on mainnet, nothing was sent"
                }
              >
                <span>{hasBlockedTokens ? '⚠️' : '⚡'}</span>
                <span>
                  {prestocksStatus?.isRateLimited
                    ? "Buy Disabled (Rate-limited)"
                    : (prestocksStatus?.dataAgeSeconds || 0) > 60
                    ? `Buy Disabled (${prestocksStatus?.dataAgeSeconds}s old)`
                    : hasBlockedTokens
                    ? "Review Guard Block"
                    : isRealBuyLive
                    ? `Buy Basket ($${amountUsdc.toFixed(2)})`
                    : "Simulate basket (nothing is sent)"}
                </span>
              </button>
              {!isRealBuyLive && !hasBlockedTokens && (
                <div className="text-[10px] text-zinc-500 font-mono text-center pt-1">
                  Dry run: simulated on mainnet, nothing was sent
                </div>
              )}
            </div>
          </div>

          {/* Hard Risk Banner (Item 10) */}
          <div className="p-4 rounded-lg bg-zinc-950 border border-zinc-800/80 text-xs text-zinc-400 space-y-1.5 leading-relaxed font-sans">
            <div className="font-semibold text-zinc-300 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider mb-1">
              <span>⚠️</span> Essential Risk Disclosures & Limitations
            </div>
            <ul className="list-disc pl-4 space-y-1 text-[11px]">
              <li className="text-zinc-300 font-medium">
                Token transfer fees are set by the issuer and can change ({feeBannerText}).
              </li>
              <li>Not available to US persons or residents of restricted jurisdictions.</li>
              <li>Tokens give economic price exposure only, not equity or shareholder rights in the underlying companies.</li>
              <li>The underlying structure is disputed: OpenAI and Anthropic have stated that SPV share transfers are invalid.</li>
              <li>Markets are thin; selling back may cost more than the quote suggests.</li>
              <li>This application does not provide investment or financial advice.</li>
            </ul>
          </div>
        </div>
        {/* Modal Dialog: Single-Token Swap Preparation, Review & Confirmation */}
        {buyStep !== 'IDLE' && (
          <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-[#121215] border border-[#27272a] rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-5 font-mono text-xs">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-[#27272a] pb-3">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#14f195]"></span>
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                    {buyStep === 'SUCCESS'
                      ? (isBasketMode ? 'Basket Swaps Confirmed' : 'Swap Confirmed')
                      : buyStep === 'ERROR'
                      ? 'Swap Notification'
                      : isBasketMode
                      ? (preparedBasket?.isDemo || !isRealBuyLive ? 'Dry run: basket simulation' : `Review & Sign: Basket (${preparedBasket?.legs?.length || selectedSymbols.length} Tokens)`)
                      : (preparedSwap?.isDemo || !isRealBuyLive ? 'Dry run: single swap simulation' : `Review & Sign: ${activeBuyToken}`)}
                  </h3>
                </div>
                <button
                  onClick={() => {
                    setBuyStep('IDLE');
                    setBuyError(null);
                    setIsBasketMode(false);
                    setPreparedBasket(null);
                    setPreparedSwap(null);
                  }}
                  className="text-zinc-400 hover:text-white text-base leading-none px-2 py-1 rounded"
                >
                  ✕
                </button>
              </div>

              {/* Step: PREPARING */}
              {buyStep === 'PREPARING' && (
                <div className="py-8 text-center space-y-3">
                  <div className="inline-block h-8 w-8 border-2 border-[#14f195] border-t-transparent rounded-full animate-spin"></div>
                  <div className="text-zinc-300 font-medium">
                    Re-fetching fresh quotes and simulating swap on Helius RPC...
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    Verifying safety guards, pool depth, and Token-2022 transfer fee
                  </div>
                </div>
              )}

              {/* Step: CONFIRMING (Review before Phantom prompt) */}
              {buyStep === 'CONFIRMING' && (preparedSwap || preparedBasket) && (
                <div className="space-y-4">
                  {(preparedSwap?.isDemo || preparedBasket?.isDemo) && (
                    <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/60 text-amber-300 text-[11px] font-sans">
                      <span className="font-bold">ℹ️ Demo Preview Mode:</span> Live buying is currently disabled in this build (<code className="font-mono text-amber-200">ENABLE_REAL_BUY=false</code>). In live mode, this simulates on-chain and prompts Phantom for manual signature.
                    </div>
                  )}

                  {/* 45s Blockhash Expiration Countdown Banner (Item 3) */}
                  <div className={`p-2.5 rounded-lg border flex items-center justify-between text-xs font-mono transition ${
                    secondsUntilExpiry <= 10
                      ? 'bg-rose-950/40 border-rose-800 text-rose-300 animate-pulse'
                      : 'bg-[#18181b] border-[#27272a] text-zinc-300'
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${secondsUntilExpiry <= 10 ? 'bg-rose-500' : 'bg-[#14f195]'}`}></span>
                      <span>Transaction Blockhash Validity:</span>
                    </div>
                    <div className="font-bold">
                      {secondsUntilExpiry > 0 ? (
                        <span className={secondsUntilExpiry <= 10 ? 'text-rose-400' : 'text-[#14f195]'}>
                          Expires in {secondsUntilExpiry}s
                        </span>
                      ) : (
                        <span className="text-rose-400">EXPIRED (Re-preparing...)</span>
                      )}
                    </div>
                  </div>

                  {isBasketMode && preparedBasket ? (
                    /* Basket Breakdown */
                    <div className="space-y-3">
                      {preparedBasket.isDemo ? (
                        /* Dry-run simulation header */
                        <div className="p-3 rounded-lg bg-[#18181b] border border-emerald-500/40 space-y-1.5">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                              ✓ {preparedBasket.label || "Dry run: simulated on mainnet, nothing was sent"}
                            </span>
                            <span className="text-zinc-300 font-mono text-xs">Total: ${preparedBasket.totalUsdc?.toFixed(2)} USDC</span>
                          </div>
                          <div className="text-[11px] text-zinc-400 font-mono flex flex-col sm:flex-row sm:items-center justify-between gap-1 pt-1 border-t border-[#27272a]/60">
                            <span>Demo wallet (read-only simulation)</span>
                            <span className="text-zinc-500 text-[10px]">Read from DEMO_SIM_ADDRESS</span>
                          </div>
                        </div>
                      ) : (
                        <div className="p-3 rounded-lg bg-[#18181b] border border-[#27272a] flex items-center justify-between">
                          <div>
                            <span className="text-[10px] text-zinc-400 uppercase block">Multi-Token Basket</span>
                            <span className="text-white font-bold text-sm">
                              {preparedBasket.legs?.length} Approved PreStocks Legs
                            </span>
                          </div>
                          <div>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                              Server Guard Verified
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Warnings */}
                      {preparedBasket.warnings && preparedBasket.warnings.length > 0 && (
                        <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/60 text-amber-300 text-[11px] font-sans space-y-1">
                          <div className="font-bold uppercase tracking-wider font-mono text-[10px] text-amber-400">
                            ⚠️ Basket Guard Warning Notice
                          </div>
                          <div>{cleanReasons(preparedBasket.warnings)}</div>
                        </div>
                      )}

                      {/* Partial Failure UI (Item 1b) */}
                      {preparedBasket.hasFailures && (
                        <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-800/60 text-rose-300 text-[11px] font-sans space-y-2">
                          <div className="font-bold uppercase tracking-wider font-mono text-[10px] text-rose-400 flex items-center gap-1.5">
                            <span>⚠️</span>
                            <span>Partial Simulation Failure</span>
                          </div>
                          <p className="text-xs text-rose-200">
                            One or more legs failed simulation or safety checks. You can re-quote only the failed legs through the full safety guard (no auto-retries).
                          </p>
                          <div className="pt-1">
                            <button
                              onClick={handleReQuoteFailedLegs}
                              className="px-3 py-1.5 rounded bg-rose-500 hover:bg-rose-400 text-black font-mono font-bold text-xs transition flex items-center gap-1.5 shadow"
                            >
                              <span>🛡️</span>
                              <span>Re-quote failed legs</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Basket Legs List with dry-run simulation metrics (Item 1a) */}
                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {preparedBasket.legs?.map((leg: any) => (
                          <div key={leg.symbol} className="p-2.5 rounded bg-[#0c0c0e] border border-[#27272a] text-[11px] space-y-1.5">
                            <div className="flex justify-between items-center">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-white">{leg.symbol}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase font-mono ${
                                  leg.status === 'FAIL'
                                    ? 'bg-rose-500/10 text-rose-400 border border-rose-500/30'
                                    : leg.status === 'WARN' || leg.guardStatus === 'WARN'
                                    ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                                    : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                                }`}>
                                  {leg.status === 'FAIL' ? '✗ FAIL' : (leg.status === 'WARN' || leg.guardStatus === 'WARN') ? '⚠️ WARN' : '✓ PASS'}
                                </span>
                              </div>
                              <span className="text-emerald-400 font-mono">${(leg.allocationUsdc ?? 0).toFixed(2)} USDC</span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[10px] text-zinc-400 font-mono pt-1 border-t border-[#27272a]/60">
                              <div>Tokens: <span className="text-zinc-200 font-bold">{leg.status === 'FAIL' || leg.simulatedTokensOut === 'n/a' || !leg.simulatedTokensOut ? 'n/a' : `~${typeof leg.simulatedTokensOut === 'number' ? leg.simulatedTokensOut.toFixed(6) : leg.simulatedTokensOut}`}</span></div>
                              <div>Compute: <span className="text-zinc-200">{leg.computeUnits ? `${leg.computeUnits.toLocaleString()} CU` : '—'}</span></div>
                              <div>Tx Size: <span className="text-zinc-200">{leg.txSizeBytes ? `${leg.txSizeBytes} B` : '—'}</span></div>
                              <div>Venue: <span className="text-zinc-200">{leg.routeType || leg.venue || '—'}</span></div>
                            </div>

                            <div className="flex justify-between items-center text-zinc-400 text-[10px] font-mono">
                              <span>Exec: ${leg.executablePrice?.toFixed(2) || leg.summary?.executablePrice?.toFixed(2) || '—'}</span>
                              <span>Mark: ${leg.markPrice?.toFixed(2) || leg.summary?.markPrice?.toFixed(2) || '—'} ({leg.markAgeSeconds ?? 0}s old)</span>
                              <span className={(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0) > 5 ? 'text-rose-400' : 'text-emerald-400'}>
                                {(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0) >= 0 ? '+' : ''}{(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0).toFixed(1)}%
                              </span>
                            </div>

                            {leg.warnings && leg.warnings.length > 0 && (
                              <div className="text-[10px] text-amber-400 font-mono bg-amber-950/30 p-1.5 rounded border border-amber-900/50 break-all">
                                ⚠️ Guard warning: {cleanReasons(leg.warnings)}
                              </div>
                            )}

                            {leg.err && (
                              <div className="text-[10px] text-rose-400 font-mono bg-rose-950/30 p-1.5 rounded border border-rose-900/50 break-all">
                                Error: {leg.err}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Basket Actions */}
                      <div className="pt-2 flex flex-col sm:flex-row items-center gap-2.5">
                        {preparedBasket.isDemo ? (
                          <button
                            onClick={() => {
                              setBuyStep('IDLE');
                              setIsBasketMode(false);
                            }}
                            className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition"
                          >
                            Close Dry Run
                          </button>
                        ) : secondsUntilExpiry <= 0 ? (
                          <button
                            onClick={() => handleInitiateBasketBuy(userConfirmedWarn)}
                            className="w-full py-2.5 rounded-lg bg-rose-500 hover:bg-rose-400 text-black font-bold transition"
                          >
                            Blockhash Expired — Re-quote Basket
                          </button>
                        ) : preparedBasket.requiresExplicitConfirm ? (
                          <button
                            disabled={isReverifying}
                            onClick={() => handleInitiateBasketBuy(true)}
                            className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold transition flex items-center justify-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed"
                          >
                            {isReverifying ? (
                              <>
                                <span className="inline-block h-4 w-4 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                                <span>Re-verifying Basket...</span>
                              </>
                            ) : (
                              <span>Confirm Warning & Re-verify Basket</span>
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={handleConfirmAndSignBasket}
                            className="w-full py-2.5 rounded-lg bg-[#14f195] hover:bg-[#10c87b] text-black font-bold transition flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(20,241,149,0.2)]"
                          >
                            <span>⚡</span>
                            <span>Proceed to Sign Basket in Phantom</span>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setBuyStep('IDLE');
                            setIsBasketMode(false);
                          }}
                          className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-[#18181b] hover:bg-[#27272a] text-zinc-300 border border-[#27272a] transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : preparedSwap ? (
                    /* Single Token Breakdown */
                    <div className="space-y-4">
                      {/* Item 12: Venue Name and Verified/Unverified Status */}
                      <div className="p-3 rounded-lg bg-[#18181b] border border-[#27272a] flex items-center justify-between">
                        <div>
                          <span className="text-[10px] text-zinc-400 uppercase block">Trading Venue</span>
                          <span className="text-white font-bold text-sm">
                            {preparedSwap.summary?.routeType || 'Meteora DLMM'}
                          </span>
                        </div>
                        <div>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border ${
                              preparedSwap.summary?.venueStatus === 'VERIFIED'
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            }`}
                          >
                            {preparedSwap.summary?.venueStatus === 'VERIFIED' ? '✓ Verified Venue' : '⚠️ Unverified Venue'}
                          </span>
                        </div>
                      </div>

                      {/* Guard Warnings if any */}
                      {preparedSwap.warnings && preparedSwap.warnings.length > 0 && (
                        <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/60 text-amber-300 text-[11px] font-sans space-y-1">
                          <div className="font-bold uppercase tracking-wider font-mono text-[10px] text-amber-400">
                            ⚠️ Guard Warning Notice
                          </div>
                          <div>{cleanReasons(preparedSwap.warnings)}</div>
                        </div>
                      )}

                      {/* Swap Breakdown Table */}
                      <div className="space-y-2 bg-[#0c0c0e] p-3.5 rounded-lg border border-[#27272a] text-[11px]">
                        <div className="flex justify-between text-zinc-400">
                          <span>USDC Spend (Hard Capped):</span>
                          <span className="text-white font-bold">${(preparedSwap.summary?.spendUsdc ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-zinc-400">
                          <span>Executable Price:</span>
                          <span className="text-white font-semibold">${(preparedSwap.summary?.executablePrice ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-zinc-400">
                          <span>PreStocks Mark Price:</span>
                          <span className="text-zinc-300">${(preparedSwap.summary?.markPrice ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-zinc-400">
                          <span>Valuation Markup:</span>
                          <span className={(preparedSwap.summary?.premiumVsMarkPct ?? 0) > 5 ? 'text-rose-400 font-bold' : 'text-emerald-400'}>
                            {(preparedSwap.summary?.premiumVsMarkPct ?? 0) >= 0 ? '+' : ''}{(preparedSwap.summary?.premiumVsMarkPct ?? 0).toFixed(1)}%
                          </span>
                        </div>
                        <div className="pt-2 border-t border-[#27272a] flex justify-between text-zinc-300">
                          <span>Expected Net Tokens:</span>
                          <span className="text-emerald-400 font-bold font-mono">
                            {(preparedSwap.summary?.expectedNetTokens ?? 0).toFixed(6)} {preparedSwap.summary?.symbol || ''}
                          </span>
                        </div>
                        <div className="flex justify-between text-zinc-400 text-[10px]">
                          <span>Guaranteed Minimum (Slippage + Fee):</span>
                          <span className="text-zinc-300 font-mono">
                            {(preparedSwap.summary?.minReceivedTokens ?? 0).toFixed(6)}
                          </span>
                        </div>
                        {preparedSwap.summary?.feeNote && (
                          <div className="text-[10px] text-teal-400 font-sans pt-1 border-t border-[#27272a]/50">
                            {preparedSwap.summary.feeNote}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="pt-2 flex flex-col sm:flex-row items-center gap-2.5">
                        {preparedSwap.isDemo ? (
                          <button
                            onClick={() => setBuyStep('IDLE')}
                            className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition"
                          >
                            Close Demo Preview
                          </button>
                        ) : preparedSwap.requiresExplicitConfirm ? (
                          <button
                            disabled={isReverifying}
                            onClick={() => handleInitiateBuy(activeBuyToken!, true)}
                            className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold transition flex items-center justify-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed"
                          >
                            {isReverifying ? (
                              <>
                                <span className="inline-block h-4 w-4 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                                <span>Re-verifying with Safety Guards...</span>
                              </>
                            ) : (
                              <span>Confirm Warning & Re-verify</span>
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={handleConfirmAndSign}
                            className="w-full py-2.5 rounded-lg bg-[#14f195] hover:bg-[#10c87b] text-black font-bold transition flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(20,241,149,0.2)]"
                          >
                            <span>⚡</span>
                            <span>Proceed to Sign in Phantom</span>
                          </button>
                        )}
                        <button
                          onClick={() => setBuyStep('IDLE')}
                          className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-[#18181b] hover:bg-[#27272a] text-zinc-300 border border-[#27272a] transition"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              )}

              {/* Step: SIGNING */}
              {buyStep === 'SIGNING' && (
                <div className="py-8 text-center space-y-3">
                  <div className="inline-block h-8 w-8 border-2 border-[#9945ff] border-t-transparent rounded-full animate-spin"></div>
                  <div className="text-zinc-200 font-medium">
                    Waiting for manual approval in Phantom wallet...
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Check your Phantom extension window to review and sign.
                  </div>
                </div>
              )}

              {/* Step: CONFIRMING_TX */}
              {buyStep === 'CONFIRMING_TX' && (
                <div className="py-8 text-center space-y-3">
                  <div className="inline-block h-8 w-8 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin"></div>
                  <div className="text-zinc-200 font-medium">
                    Transaction broadcast to Solana network...
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Polling confirmation statuses via secure RPC proxy
                  </div>
                </div>
              )}

              {/* Step: SUCCESS (Receipt) */}
              {buyStep === 'SUCCESS' && (swapReceipt || basketReceipts.length > 0) && (
                <div className="space-y-4">
                  <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-800/60 text-emerald-300 text-xs font-sans">
                    ✓ {isBasketMode ? `${basketReceipts.length} basket legs successfully confirmed on Solana mainnet!` : 'Swap transaction successfully confirmed on Solana mainnet!'}
                  </div>

                  {isBasketMode && basketReceipts.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {basketReceipts.map((rcpt) => (
                        <div key={rcpt.signature} className="p-3 rounded bg-[#0c0c0e] border border-[#27272a] text-[11px] space-y-1">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-white">{rcpt.symbol}</span>
                            <span className="text-emerald-400 font-mono">${rcpt.amountUsdc.toFixed(2)} USDC</span>
                          </div>
                          <div className="flex justify-between text-zinc-400 text-[10px]">
                            <span>Delivered:</span>
                            <span className="text-zinc-200 font-mono font-bold">~{rcpt.expectedNetTokens.toFixed(6)} tokens</span>
                          </div>
                          <div className="pt-1 border-t border-[#27272a]/40">
                            <a
                              href={rcpt.solscanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#14f195] hover:underline font-mono text-[10px] break-all block"
                            >
                              Tx: {rcpt.signature.slice(0, 16)}...{rcpt.signature.slice(-8)} ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : swapReceipt ? (
                    <div className="space-y-2 bg-[#0c0c0e] p-3.5 rounded-lg border border-[#27272a] text-[11px]">
                      <div className="flex justify-between text-zinc-400">
                        <span>Token Swapped:</span>
                        <span className="text-white font-bold">{swapReceipt.symbol}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>USDC Spent:</span>
                        <span className="text-white font-mono">${swapReceipt.amountUsdc.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Quoted Expected Tokens:</span>
                        <span className="text-zinc-300 font-mono">{swapReceipt.expectedNetTokens.toFixed(6)}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Actual Tokens Received:</span>
                        <span className="text-emerald-400 font-bold font-mono">
                          {swapReceipt.actualTokensReceived !== null ? swapReceipt.actualTokensReceived.toFixed(6) : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Diff (Actual vs Quoted):</span>
                        <span className={`font-mono font-bold ${
                          (swapReceipt.diffTokens ?? 0) >= 0 ? 'text-emerald-400' : 'text-amber-400'
                        }`}>
                          {swapReceipt.diffTokens !== null && swapReceipt.diffTokens !== undefined
                            ? `${swapReceipt.diffTokens >= 0 ? '+' : ''}${swapReceipt.diffTokens.toFixed(6)}`
                            : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between text-zinc-400 text-[10px]">
                        <span>Quoted Minimum:</span>
                        <span className="text-zinc-300 font-mono">{swapReceipt.minTokens.toFixed(6)}</span>
                      </div>
                      <div className="pt-2 border-t border-[#27272a] flex flex-col gap-1">
                        <span className="text-zinc-400 text-[10px]">Solscan Explorer Link:</span>
                        <a
                          href={swapReceipt.solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#14f195] hover:underline font-mono text-[10px] break-all"
                        >
                          {swapReceipt.signature} ↗
                        </a>
                      </div>
                      <div className="text-[10px] text-zinc-400 font-sans pt-1 border-t border-[#27272a]/50">
                        Delivered net of Token-2022 transfer fee (1.00%) and AMM execution slippage.
                      </div>
                    </div>
                  ) : null}

                  <button
                    onClick={() => {
                      setBuyStep('IDLE');
                      setSwapReceipt(null);
                      setBasketReceipts([]);
                      setIsBasketMode(false);
                    }}
                    className="w-full py-2.5 rounded-lg bg-[#14f195] hover:bg-[#10c87b] text-black font-bold transition"
                  >
                    Done
                  </button>
                </div>
              )}

              {/* Step: TIMEOUT (Status Unknown) */}
              {buyStep === 'TIMEOUT' && (swapReceipt || basketReceipts.length > 0) && (
                <div className="space-y-4">
                  <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/60 text-amber-300 text-xs font-sans">
                    <span className="font-bold">Status Unknown:</span> Confirmation timed out after 30 seconds. Neither success nor failure is claimed.
                  </div>

                  {isBasketMode && basketReceipts.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {basketReceipts.map((rcpt) => (
                        <div key={rcpt.signature} className="p-3 rounded bg-[#0c0c0e] border border-[#27272a] text-[11px] space-y-1">
                          <div className="flex justify-between items-center">
                            <span className="font-bold text-white">{rcpt.symbol}</span>
                            <span className="text-white font-mono">${rcpt.amountUsdc.toFixed(2)} USDC</span>
                          </div>
                          <div className="pt-1 border-t border-[#27272a]/40">
                            <a
                              href={rcpt.solscanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#14f195] hover:underline font-mono text-[10px] break-all block"
                            >
                              Check Solscan: {rcpt.signature.slice(0, 16)}...{rcpt.signature.slice(-8)} ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : swapReceipt ? (
                    <div className="space-y-2 bg-[#0c0c0e] p-3.5 rounded-lg border border-[#27272a] text-[11px]">
                      <div className="flex justify-between text-zinc-400">
                        <span>Token Swapped:</span>
                        <span className="text-white font-bold">{swapReceipt.symbol}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>USDC Committed:</span>
                        <span className="text-white font-mono">${swapReceipt.amountUsdc.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-zinc-400">
                        <span>Quoted Tokens:</span>
                        <span className="text-zinc-300 font-mono">{swapReceipt.expectedNetTokens.toFixed(6)}</span>
                      </div>
                      <div className="pt-2 border-t border-[#27272a] flex flex-col gap-1">
                        <span className="text-zinc-400 text-[10px]">Check Solscan to verify transaction outcome:</span>
                        <a
                          href={swapReceipt.solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#14f195] hover:underline font-mono text-[10px] break-all"
                        >
                          {swapReceipt.solscanUrl} ↗
                        </a>
                      </div>
                      <div className="text-[10px] text-amber-400/90 font-sans pt-1 border-t border-[#27272a]/50">
                        The transaction was broadcast to the cluster and may still confirm or fail. Please check Solscan before retrying.
                      </div>
                    </div>
                  ) : null}

                  <button
                    onClick={() => {
                      setBuyStep('IDLE');
                      setSwapReceipt(null);
                      setBasketReceipts([]);
                      setIsBasketMode(false);
                    }}
                    className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Step: ERROR */}
              {buyStep === 'ERROR' && (
                <div className="space-y-4">
                  <div className="p-3 rounded-lg bg-rose-950/30 border border-rose-800/60 text-rose-300 text-xs font-sans">
                    <span className="font-bold">Trade Halted:</span> {buyError || 'An error occurred during trade preparation.'}
                  </div>

                  <button
                    onClick={() => {
                      setBuyStep('IDLE');
                      setBuyError(null);
                    }}
                    className="w-full py-2.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-bold transition"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#27272a] py-6 text-center text-xs text-[#71717a] font-mono">
        PreVal — Stocklana Hackathon Submission • PreStocks + Jupiter-routed liquidity
      </footer>
    </div>
  );
}
