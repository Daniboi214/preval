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
  const [amountUsdc, setAmountUsdc] = useState<number>(3.00);
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

  const [expandedSymbols, setExpandedSymbols] = useState<string[]>(['FIGUREAI', 'OPENAI']);
  const toggleExpand = (symbol: string) => {
    setExpandedSymbols((prev) =>
      prev.includes(symbol) ? prev.filter((s) => s !== symbol) : [...prev, symbol]
    );
  };

  const getPlainVerdict = (q: TokenQuote) => {
    if (q.guardStatus === 'BLOCK') {
      const reasons = q.blockedReasons && q.blockedReasons.length > 0
        ? q.blockedReasons.map((r) => r.trim().replace(/\.+$/, '')).join('; ')
        : (q.error || 'Blocked by valuation guard');
      return {
        text: `Blocked: ${reasons}`,
        severity: 'block'
      };
    }

    if (q.guardStatus === 'WARN') {
      const warningsText = (q.warnings || []).join(' ').toLowerCase();

      // 1. Premium above threshold
      if (q.premiumVsMarkPct !== null && q.premiumVsMarkPct > maxPremium) {
        return {
          text: `Trading +${q.premiumVsMarkPct.toFixed(1)}% above fair value`,
          severity: 'warn'
        };
      }

      // 2. Exit cost exceeding 3%
      if ((q.roundTripLossPct !== null && q.roundTripLossPct > 3.0) || warningsText.includes('exit cost') || warningsText.includes('round-trip')) {
        return {
          text: 'Selling back right now would cost more than usual',
          severity: 'warn'
        };
      }

      // 3. Pool impact noise
      if (warningsText.includes('pool impact is high') || warningsText.includes('size impact is unverified') || warningsText.includes('different venues')) {
        return {
          text: 'Minor caution, likely not a real issue',
          severity: 'warn-soft'
        };
      }

      const cleanWarn = q.warnings && q.warnings.length > 0
        ? q.warnings[0].trim().replace(/\.+$/, '')
        : 'Caution: check details before trading';
      return {
        text: cleanWarn,
        severity: 'warn'
      };
    }

    return {
      text: 'Fair price — looks good',
      severity: 'pass'
    };
  };

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

  // Support custom token selection or auto-trigger via query params
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      const tokensParam = params.get('tokens');
      if (tokensParam) {
        setSelectedSymbols(tokensParam.split(',').map((s) => s.trim().toUpperCase()));
      }
    }
  }, []);

  // Auto-trigger single token buy or dry run once quotes finish loading
  useEffect(() => {
    if (typeof window !== 'undefined' && window.location.search && !loading && quotes.length > 0 && buyStep === 'IDLE') {
      const params = new URLSearchParams(window.location.search);
      const buyParam = params.get('buy');
      if (buyParam) {
        handleInitiateBuy(buyParam.trim().toUpperCase());
      } else if (window.location.search.includes('dryrun=1')) {
        handleInitiateBasketBuy();
      }
    }
  }, [loading, quotes, buyStep]);

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

    // Check if live buying is disabled (dry-run preview mode)
    if (!isRealBuyLive) {
      const q = quotes.find((t) => t.symbol === symbol);
      const isWarn = q?.guardStatus === 'WARN' || (q?.warnings && q.warnings.length > 0);
      setPreparedSwap({
        isDemo: true,
        guardStatus: q?.guardStatus || 'PASS',
        warnings: q?.warnings || [],
        requiresExplicitConfirm: Boolean(isWarn && !confirmedWarn),
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
      setPreparedAt(Date.now());
      setBuyStep('CONFIRMING');
      return;
    }

    // If wallet is not connected, prompt to connect
    if (!wallet.publicKey) {
      setBuyStep('ERROR');
      setBuyError('Please connect your Phantom wallet to initiate a single-token swap.');
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
            totalUsdc: Math.min(amountUsdc, 3.0)
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
    <div className="min-h-screen bg-[#f8fafc] text-slate-900 flex flex-col justify-between">
      {/* Top Navigation */}
      <header className="border-b border-slate-200/80 bg-white/90 backdrop-blur-md sticky top-0 z-50 shadow-2xs">
        <div className="max-w-6xl mx-auto px-2.5 sm:px-6 py-3 flex items-center justify-between gap-1.5 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            <div className="w-8 h-8 shrink-0 flex items-center justify-center">
              <img src="/logo.png" alt="PreVal Logo" className="w-8 h-auto max-h-8 object-contain" />
            </div>
            <div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <span className="font-semibold text-slate-900 text-base sm:text-lg tracking-tight">PreVal</span>
                <span
                  className={`text-[10px] sm:text-[11px] font-medium px-1.5 sm:px-2.5 py-0.5 rounded-full border inline-flex items-center gap-1 sm:gap-1.5 whitespace-nowrap ${
                    isRealBuyLive
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isRealBuyLive ? 'bg-emerald-500' : 'bg-slate-400'}`}></span>
                  <span className="hidden sm:inline">
                    {isRealBuyLive ? 'Live Buying Enabled (max $2)' : 'Preview Mode (live buying off in this demo)'}
                  </span>
                  <span className="sm:hidden">
                    {isRealBuyLive ? 'Live' : 'Preview'}
                  </span>
                </span>
              </div>
              <p className="text-[11px] text-slate-500 hidden sm:block font-normal mt-0.5">
                Guarded PreStocks Basket on Solana
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-3 shrink-0">
            {/* Wallet balances if connected */}
            {wallet.connected && wallet.publicKey && (
              <div className="hidden md:flex items-center gap-2 bg-slate-50 border border-slate-200 px-3 py-1.5 rounded-lg text-xs font-mono text-slate-600">
                <span className="text-slate-500">SOL:</span>
                <span className="text-slate-900 font-semibold">{balanceLoading ? '...' : (solBalance ?? 0)}</span>
                <span className="text-slate-300">|</span>
                <span className="text-slate-500">USDC:</span>
                <span className="text-emerald-600 font-semibold">${balanceLoading ? '...' : (usdcBalance ?? 0).toFixed(2)}</span>
              </div>
            )}

            <button
              onClick={() => fetchQuotes()}
              disabled={loading}
              className="text-[11px] sm:text-xs font-mono px-2 sm:px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition flex items-center gap-1.5 text-slate-700 hover:text-slate-900 shadow-2xs shrink-0 cursor-pointer"
              title="Click to refresh quotes"
            >
              <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${loading ? 'bg-amber-400 animate-ping' : 'bg-emerald-500'}`}></span>
              <span className="font-medium">{loading ? 'Refreshing...' : `Refreshes in ${secondsRemaining}s`}</span>
            </button>

            {/* Phantom Connect Wallet button */}
            <div className="wallet-button-wrapper shrink-0">
              <WalletMultiButton className="!bg-slate-900 hover:!bg-slate-800 !text-white !font-medium !text-xs !rounded-lg !h-9 !py-0 !px-2.5 sm:!px-3.5 !transition !shadow-xs" />
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8 w-full space-y-8 flex-1">
        {/* Pitch Hero */}
        <div className="relative -mx-4 sm:-mx-6 -mt-8 px-4 sm:px-6 pt-10 pb-3 rounded-b-3xl overflow-hidden [background:radial-gradient(ellipse_80%_60%_at_50%_0%,rgba(5,150,105,0.06)_0%,rgba(248,250,252,0)_100%)]">
          <div className="max-w-3xl space-y-3 relative z-10">
            <h1 className="text-3xl sm:text-4xl lg:text-[40px] font-semibold tracking-tight text-slate-900 leading-[1.2]">
              Buy the private AI & frontier-tech wave in one click,{' '}
              <span className="text-emerald-600 block sm:inline">
                without overpaying.
              </span>
            </h1>
            <p className="text-base sm:text-lg text-slate-600 leading-relaxed font-normal max-w-2xl">
              Compares live Jupiter prices with PreStocks' mark price and checks pool depth before you buy.
            </p>
          </div>
        </div>

        {/* Controls Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl p-5 sm:p-6 shadow-xs space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 tracking-tight">
                1. Configure Your Basket
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">Select preset or toggle individual tokens</p>
            </div>
            <button
              onClick={applyPreset}
              className="text-xs font-medium px-3 py-1.5 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg text-slate-700 transition shadow-2xs cursor-pointer"
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
                  className={`px-3 py-2 rounded-lg border text-left transition flex items-center gap-2 text-xs cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-50/80 border-emerald-500 text-slate-900 shadow-2xs'
                      : 'bg-slate-50/70 border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-100/60'
                  }`}
                >
                  <span
                    className={`h-2 w-2 rounded-full shrink-0 ${
                      isSelected ? (isHighMarkupCandidate ? 'bg-rose-500' : 'bg-emerald-500') : 'bg-slate-300'
                    }`}
                  />
                  <div>
                    <span className="font-semibold">{t.symbol}</span>
                    {isHighMarkupCandidate && (
                      <span className="ml-1.5 text-[10px] text-rose-600 font-medium">
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
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Total USDC Amount
              </label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-slate-500 font-medium">$</span>
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
                  className="w-full bg-slate-50 focus:bg-white border border-slate-200 focus:border-slate-400 focus:ring-2 focus:ring-slate-100 rounded-lg pl-7 pr-3 py-2 text-sm text-slate-900 font-mono font-medium outline-none transition shadow-2xs"
                />
              </div>
              <span className="text-[11px] text-slate-600 mt-1.5 block">Live buys in this demo are capped at $3 (basket) and $2 (single token).</span>
              {clampNote && (
                <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200/80 rounded-md px-2 py-1 font-mono mt-1.5">{clampNote}</div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Most I'll pay above fair price
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
                  className="w-full bg-slate-50 focus:bg-white border border-slate-200 focus:border-slate-400 focus:ring-2 focus:ring-slate-100 rounded-lg pl-3 pr-7 py-2 text-sm text-slate-900 font-mono font-medium outline-none transition shadow-2xs"
                />
                <span className="absolute right-3 top-2.5 text-xs text-slate-500 font-medium">%</span>
              </div>
              <span className="text-[11px] text-slate-600 mt-1.5 block">Default: +5.0% above mark price</span>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
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
                  className="w-full bg-slate-50 focus:bg-white border border-slate-200 focus:border-slate-400 focus:ring-2 focus:ring-slate-100 rounded-lg pl-3 pr-7 py-2 text-sm text-slate-900 font-mono font-medium outline-none transition shadow-2xs"
                />
                <span className="absolute right-3 top-2.5 text-xs text-slate-500 font-medium">%</span>
              </div>
              <span className="text-[11px] text-slate-600 mt-1.5 block">Default: 2.0% empirical impact threshold</span>
            </div>
          </div>
        </div>

        {/* Live Valuation & Guard Verification Card */}
        <div className="bg-white border border-slate-200/80 rounded-2xl shadow-xs overflow-hidden">
          {/* Section Header */}
          <div className="px-5 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3 bg-white">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 tracking-tight flex items-center gap-2">
                <span className="flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold">2</span>
                Live Valuation & Guard Verification
              </h2>
              <p className="text-xs text-slate-600 mt-0.5">
                Quotes fetched via Jupiter and compared with PreStocks' mark prices
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="text-emerald-700 bg-emerald-50 px-2.5 py-0.5 rounded-full border border-emerald-200">
                {passCount} Pass
              </span>
              {warnCount > 0 && (
                <span className="text-amber-700 bg-amber-50 px-2.5 py-0.5 rounded-full border border-amber-200">
                  {warnCount} Warn
                </span>
              )}
              {blockedCount > 0 && (
                <span className="text-rose-700 bg-rose-50 px-2.5 py-0.5 rounded-full border border-rose-200">
                  {blockedCount} Blocked
                </span>
              )}
            </div>
          </div>

          {/* Top of Results: Rate limited or Stale-if-error notice */}
          {prestocksStatus && (prestocksStatus.isRateLimited || prestocksStatus.isStale) && (
            <div className="p-3.5 bg-amber-50 border-b border-amber-200/80 flex items-center justify-between gap-3 text-xs text-amber-800">
              <div className="flex items-center gap-2">
                <span>
                  {prestocksStatus.isRateLimited
                    ? `PreStocks data is temporarily rate-limited. Showing last good data from ${prestocksStatus.dataAgeSeconds > 60 ? `${Math.floor(prestocksStatus.dataAgeSeconds / 60)} minute(s)` : `${prestocksStatus.dataAgeSeconds}s`} ago.`
                    : `PreStocks mark prices are cached (${prestocksStatus.dataAgeSeconds}s old).`}
                </span>
              </div>
              <span className="text-[11px] font-medium text-amber-700 uppercase tracking-wider px-2 py-0.5 rounded bg-amber-100/60 border border-amber-200">
                Preview Only — Buy Disabled
              </span>
            </div>
          )}

          {/* Top of Results: Highlight blocked tokens & instant re-split button */}
          {hasBlockedTokens && (
            <div className="p-3.5 bg-rose-50 border-b border-rose-200/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
              <div className="text-xs text-rose-800 font-medium">
                <span className="font-semibold text-rose-900">{blockedNames}</span>{' '}
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
              {!isStaleDataBlock && (
                <button
                  onClick={excludeBlockedTokens}
                  className="text-xs font-medium px-3 py-1.5 rounded-lg bg-white hover:bg-rose-100/80 text-rose-700 border border-rose-200 transition flex items-center gap-1.5 shrink-0 cursor-pointer shadow-2xs"
                >
                  <span>Exclude blocked and re-split ${amountUsdc.toFixed(2)}</span>
                </button>
              )}
            </div>
          )}

          {/* Loading bar indicator for quote requests */}
          {loading && (
            <div className="h-1 w-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-400 via-teal-400 to-indigo-500 animate-pulse w-full"></div>
            </div>
          )}

          {error && (
            <div className="p-3.5 bg-rose-50 border-b border-rose-200 text-rose-700 text-xs">
              {error}
            </div>
          )}

          {/* Token Rows */}
          <div className="divide-y divide-slate-100">
            {loading && quotes.length === 0 ? (
              <div className="p-8 text-center text-slate-600 text-xs">
                <div className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-500 animate-ping"></span>
                  Fetching live on-chain quotes and reading Token-2022 extensions...
                </div>
              </div>
            ) : quotes.length === 0 ? (
              <div className="p-8 text-center text-slate-600 text-xs">
                No tokens selected. Select at least one token above.
              </div>
            ) : (
              quotes.map((q) => {
                const isExpanded = expandedSymbols.includes(q.symbol);
                const verdict = getPlainVerdict(q);
                const isBlocked = q.guardStatus === 'BLOCK';
                const isWarn = q.guardStatus === 'WARN';

                return (
                  <div
                    key={q.symbol}
                    className={`transition-colors ${
                      isBlocked
                        ? 'bg-rose-50/30 hover:bg-rose-50/50'
                        : isExpanded
                        ? 'bg-slate-50/50'
                        : 'hover:bg-slate-50/30'
                    }`}
                  >
                    {/* Collapsed / Main Row */}
                    <div className="p-4 sm:px-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
                      {/* Token Identity */}
                      <div className="flex items-center gap-3 min-w-0 sm:w-1/4">
                        <span
                          className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                            isBlocked ? 'bg-rose-500 ring-4 ring-rose-100' : isWarn ? 'bg-amber-500' : 'bg-emerald-500'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-slate-900 text-sm tracking-tight">{q.symbol}</span>
                            <span className="text-xs text-slate-600 font-normal hidden md:inline truncate max-w-[130px]">
                              {q.name}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Executable Price */}
                      <div className="text-left sm:text-right sm:w-1/5">
                        <div className="text-sm font-semibold text-slate-900 font-mono">
                          {q.executablePrice ? `$${q.executablePrice.toFixed(2)}` : (
                            <span className="text-slate-600 italic text-xs font-sans">
                              {q.errorCode === 'RATE_LIMITED' || q.errorCode === 'SERVICE_UNAVAILABLE'
                                ? 'Unavailable'
                                : 'No route'}
                            </span>
                          )}
                        </div>
                        {q.feeNote && (
                          <div className="text-[10px] text-slate-600 font-normal">
                            {q.feeNote}
                          </div>
                        )}
                      </div>

                      {/* Plain-Language Verdict */}
                      <div className="text-left sm:text-left flex-1 min-w-0">
                        {verdict.severity === 'block' ? (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold tracking-wide uppercase bg-rose-100 text-rose-800 border border-rose-200 shrink-0">
                              Blocked
                            </span>
                            <span className="text-xs font-semibold text-rose-700">
                              {verdict.text.replace(/^Blocked:\s*/i, '')}
                            </span>
                          </div>
                        ) : (
                          <span
                            className={`text-xs font-medium leading-tight block ${
                              verdict.severity === 'warn'
                                ? 'text-amber-700'
                                : verdict.severity === 'warn-soft'
                                ? 'text-amber-600'
                                : 'text-emerald-700'
                            }`}
                          >
                            {verdict.text}
                          </span>
                        )}
                      </div>

                      {/* Actions: Details toggle & single-token buy */}
                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <button
                          onClick={() => toggleExpand(q.symbol)}
                          className="text-xs font-medium text-slate-700 hover:text-slate-900 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 transition shadow-2xs flex items-center gap-1 cursor-pointer"
                        >
                          <span>{isExpanded ? 'Less' : 'Details'}</span>
                          <span className={`text-[10px] transition-transform ${isExpanded ? 'rotate-180' : ''}`}>▾</span>
                        </button>

                        <button
                          onClick={() => handleInitiateBuy(q.symbol)}
                          disabled={isBlocked || loading || buyStep === 'PREPARING'}
                          className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1 shadow-2xs ${
                            isBlocked
                              ? 'bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200'
                              : 'bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer'
                          }`}
                          title={isBlocked ? "Blocked by guard" : !isRealBuyLive ? "Simulate single token swap (demo)" : "Buy single token (max $2)"}
                        >
                          <span>Buy</span>
                        </button>
                      </div>
                    </div>

                    {/* Expanded Details Panel */}
                    {isExpanded && (
                      <div className="px-4 sm:px-6 pb-5 pt-1 bg-slate-50/70 border-t border-slate-100">
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-3 text-xs">
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Allocated</span>
                            <span className="font-semibold text-slate-900 font-mono">${q.allocatedUsdc.toFixed(2)}</span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">PreStocks Mark</span>
                            <span className="font-semibold text-slate-900 font-mono">${q.markPrice.toFixed(2)}</span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Spread vs Mark</span>
                            <span className={`font-semibold font-mono ${
                              q.premiumVsMarkPct !== null && q.premiumVsMarkPct > maxPremium
                                ? 'text-rose-600'
                                : q.premiumVsMarkPct !== null && q.premiumVsMarkPct < 0
                                ? 'text-emerald-600'
                                : 'text-slate-900'
                            }`}>
                              {q.premiumVsMarkPct !== null ? `${q.premiumVsMarkPct >= 0 ? '+' : ''}${q.premiumVsMarkPct.toFixed(1)}%` : 'N/A'}
                            </span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Exit Cost (Round-Trip)</span>
                            <span className={`font-semibold font-mono ${
                              q.roundTripLossPct !== null && q.roundTripLossPct > 3 ? 'text-amber-700' : 'text-slate-900'
                            }`}>
                              {q.roundTripLossPct !== null ? `${q.roundTripLossPct.toFixed(2)}%` : 'N/A'}
                            </span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Pool Impact (Jupiter)</span>
                            <span className={`font-semibold font-mono ${
                              q.poolImpactJupiter !== null && q.poolImpactJupiter > maxImpact ? 'text-amber-700' : 'text-slate-700'
                            }`}>
                              {q.poolImpactJupiter !== null ? `${q.poolImpactJupiter.toFixed(2)}%` : 'N/A'}
                            </span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Empirical Impact ($X vs $1)</span>
                            <span className={`font-semibold font-mono ${
                              q.empiricalImpactPct !== null && q.empiricalImpactPct > maxImpact ? 'text-rose-600' : 'text-slate-700'
                            }`}>
                              {q.empiricalImpactPct !== null ? `${q.empiricalImpactPct.toFixed(2)}%` : 'N/A'}
                            </span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Route & Venue</span>
                            <span className="font-medium text-slate-800 text-[11px] truncate block">
                              {q.hasRoute && q.routeType ? q.routeType : '—'}
                            </span>
                          </div>
                          <div className="bg-white p-2.5 rounded-xl border border-slate-200/80 shadow-2xs">
                            <span className="text-[11px] text-slate-600 uppercase font-medium block">Quote Freshness</span>
                            <span className="font-semibold text-slate-700 font-mono">
                              {q.hasRoute ? `${q.quoteAgeSeconds}s ago` : '—'}
                            </span>
                          </div>
                        </div>

                        {/* Original Precise Guard Diagnostic Text */}
                        <div className="mt-1 p-3 rounded-xl bg-white border border-slate-200/80 text-xs">
                          <span className="text-[11px] font-semibold text-slate-600 uppercase tracking-wider block mb-0.5">
                            Original Guard Diagnostic
                          </span>
                          {isBlocked ? (
                            <span className="text-rose-700 font-medium">{cleanReasons(q.blockedReasons)}</span>
                          ) : isWarn ? (
                            <span className="text-amber-800 font-medium">{cleanReasons(q.warnings)}</span>
                          ) : (
                            <span className="text-emerald-700 font-medium">All valuation limits (spread ≤ {maxPremium}%, impact ≤ {maxImpact}%, exit loss ≤ 3%) satisfied.</span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Action Row (Folded Execution Summary) */}
          <div className="p-5 sm:p-6 bg-slate-50/70 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4">
            <div>
              <div className="text-sm font-semibold text-slate-900">
                {hasBlockedTokens ? (
                  <span className="text-rose-700 flex items-center gap-1.5">
                    <span>{blockedCount} token(s) exceed protection thresholds</span>
                  </span>
                ) : (
                  <span className="text-slate-900 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                    <span>All {quotes.length} tokens verified & ready</span>
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 mt-0.5">
                {hasBlockedTokens
                  ? 'Basket execution is blocked to protect your capital.'
                  : `Simulated or executed together for $${amountUsdc.toFixed(2)} total USDC.`}
              </p>

              {hasBlockedTokens && !isStaleDataBlock && (
                <button
                  onClick={excludeBlockedTokens}
                  className="mt-2 text-xs font-medium px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 transition flex items-center gap-1.5 cursor-pointer shadow-2xs"
                >
                  <span>Exclude blocked and re-split ${amountUsdc.toFixed(2)}</span>
                </button>
              )}
            </div>

            <div className="flex flex-col items-stretch sm:items-end gap-1.5">
              <button
                onClick={() => handleInitiateBasketBuy()}
                disabled={loading || buyStep === 'PREPARING'}
                className={`px-6 py-3 rounded-xl text-sm font-semibold transition flex items-center justify-center gap-2 cursor-pointer shadow-xs ${
                  hasBlockedTokens
                    ? 'bg-rose-100 text-rose-700 border border-rose-300 hover:bg-rose-200'
                    : isRealBuyLive
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/20'
                    : 'bg-slate-900 hover:bg-slate-800 text-white'
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
                <span className="text-[11px] text-slate-600 font-normal text-center sm:text-right">
                  Dry run: simulated on mainnet, nothing was sent
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Essential Risk Disclosures & Limitations Banner */}
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 space-y-1.5 leading-relaxed font-normal">
          <div className="font-semibold text-slate-700 flex items-center gap-1.5 text-xs tracking-tight mb-1">
            Essential Risk Disclosures & Limitations
          </div>
          <ul className="list-disc pl-4 space-y-1 text-[11px]">
            <li className="text-slate-600 font-medium">
              Token transfer fees are set by the issuer and can change ({feeBannerText}).
            </li>
            <li>Not available to US persons or residents of restricted jurisdictions.</li>
            <li>Tokens give economic price exposure only, not equity or shareholder rights in the underlying companies.</li>
            <li>The underlying structure is disputed: OpenAI and Anthropic have stated that SPV share transfers are invalid.</li>
            <li>Markets are thin; selling back may cost more than the quote suggests.</li>
            <li>This application does not provide investment or financial advice.</li>
          </ul>
        </div>
        {/* Modal Dialog: Single-Token Swap Preparation, Review & Confirmation */}
        {buyStep !== 'IDLE' && (
          <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4">
            <div className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full p-6 shadow-xl space-y-5 text-slate-900 text-xs">
              {/* Header */}
              <div className="flex items-center justify-between border-b border-slate-100 pb-3.5">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-500"></span>
                  <h3 className="text-sm font-semibold text-slate-900 tracking-tight">
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
                  className="text-slate-500 hover:text-slate-800 text-base leading-none p-1 rounded-md hover:bg-slate-100 transition cursor-pointer"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Step: PREPARING */}
              {buyStep === 'PREPARING' && (
                <div className="py-8 text-center space-y-3">
                  <div className="inline-block h-8 w-8 border-2 border-slate-200 border-t-emerald-600 rounded-full animate-spin"></div>
                  <div className="text-slate-900 font-semibold text-sm">
                    Re-fetching fresh quotes and simulating swap on Helius RPC...
                  </div>
                  <div className="text-xs text-slate-600">
                    Verifying safety guards, pool depth, and Token-2022 transfer fee
                  </div>
                </div>
              )}

              {/* Step: CONFIRMING (Review before Phantom prompt) */}
              {buyStep === 'CONFIRMING' && (preparedSwap || preparedBasket) && (
                <div className="space-y-4">
                  {(preparedSwap?.isDemo || preparedBasket?.isDemo) && (
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-slate-600 text-xs">
                      <span className="font-semibold text-slate-900">Demo Preview Mode:</span> Live buying is currently disabled in this build (<code className="font-mono text-slate-800 bg-slate-200/70 px-1 py-0.5 rounded text-[11px]">ENABLE_REAL_BUY=false</code>). In live mode, this simulates on-chain and prompts Phantom for manual signature.
                    </div>
                  )}

                  {/* 45s Blockhash Expiration Countdown Banner */}
                  <div className={`p-2.5 rounded-xl border flex items-center justify-between text-xs transition ${
                    secondsUntilExpiry <= 10
                      ? 'bg-rose-50 border-rose-200 text-rose-800 animate-pulse'
                      : 'bg-slate-50 border-slate-200 text-slate-700'
                  }`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${secondsUntilExpiry <= 10 ? 'bg-rose-500' : 'bg-emerald-500'}`}></span>
                      <span className="font-medium">Transaction Blockhash Validity:</span>
                    </div>
                    <div className="font-semibold font-mono">
                      {secondsUntilExpiry > 0 ? (
                        <span className={secondsUntilExpiry <= 10 ? 'text-rose-600' : 'text-emerald-700'}>
                          Expires in {secondsUntilExpiry}s
                        </span>
                      ) : (
                        <span className="text-rose-600">EXPIRED (Re-preparing...)</span>
                      )}
                    </div>
                  </div>

                  {isBasketMode && preparedBasket ? (
                    /* Basket Breakdown */
                    <div className="space-y-3">
                      {preparedBasket.isDemo ? (
                        /* Dry-run simulation header */
                        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                              {preparedBasket.label || "Dry run: simulated on mainnet, nothing was sent"}
                            </span>
                            <span className="text-slate-900 font-mono font-semibold text-xs">Total: ${preparedBasket.totalUsdc?.toFixed(2)} USDC</span>
                          </div>
                          <div className="text-[11px] text-slate-600 flex flex-col sm:flex-row sm:items-center justify-between gap-1 pt-1.5 border-t border-slate-200/80">
                            <span>Demo wallet (read-only simulation)</span>
                            <span className="text-slate-500 text-[10px]">Read from DEMO_SIM_ADDRESS</span>
                          </div>
                        </div>
                      ) : (
                        <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                          <div>
                            <span className="text-[10px] text-slate-500 uppercase font-medium block">Multi-Token Basket</span>
                            <span className="text-slate-900 font-semibold text-sm">
                              {preparedBasket.legs?.length} Approved PreStocks Legs
                            </span>
                          </div>
                          <div>
                            <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-emerald-50 text-emerald-700 border border-emerald-200">
                              Server Guard Verified
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Warnings */}
                      {preparedBasket.warnings && preparedBasket.warnings.length > 0 && (
                        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200/80 text-amber-900 text-xs space-y-1">
                          <div className="font-semibold text-xs text-amber-900 flex items-center gap-1.5">
                            <span>Basket Guard Notice</span>
                          </div>
                          <div className="text-[11px] text-amber-800 leading-relaxed pt-0.5">{cleanReasons(preparedBasket.warnings)}</div>
                        </div>
                      )}

                      {/* Partial Failure UI */}
                      {preparedBasket.hasFailures && (
                        <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs space-y-2">
                          <div className="font-semibold text-xs text-rose-900 flex items-center gap-1.5">
                            <span>Partial Simulation Failure</span>
                          </div>
                          <p className="text-xs text-rose-800">
                            One or more legs failed simulation or safety checks. You can re-quote only the failed legs through the full safety guard (no auto-retries).
                          </p>
                          <div className="pt-1">
                            <button
                              onClick={handleReQuoteFailedLegs}
                              className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs transition flex items-center gap-1.5 shadow-2xs cursor-pointer"
                            >
                              <span>Re-quote failed legs</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Basket Legs List */}
                      <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                        {preparedBasket.legs?.map((leg: any) => (
                          <div key={leg.symbol} className="p-3 rounded-xl bg-white border border-slate-200 text-xs space-y-1.5 shadow-2xs">
                            <div className="flex justify-between items-center">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-slate-900">{leg.symbol}</span>
                                <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase ${
                                  leg.status === 'FAIL'
                                    ? 'bg-rose-50 text-rose-700 border border-rose-200'
                                    : leg.status === 'WARN' || leg.guardStatus === 'WARN'
                                    ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                    : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                }`}>
                                  {leg.status === 'FAIL' ? 'FAIL' : (leg.status === 'WARN' || leg.guardStatus === 'WARN') ? 'WARN' : 'PASS'}
                                </span>
                              </div>
                              <span className="text-slate-900 font-mono font-semibold">${(leg.allocationUsdc ?? 0).toFixed(2)} USDC</span>
                            </div>

                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1 text-[10px] text-slate-600 font-mono pt-1 border-t border-slate-100">
                              <div>Tokens: <span className="text-slate-800 font-semibold">{leg.status === 'FAIL' || leg.simulatedTokensOut === 'n/a' || !leg.simulatedTokensOut ? 'n/a' : `~${typeof leg.simulatedTokensOut === 'number' ? leg.simulatedTokensOut.toFixed(6) : leg.simulatedTokensOut}`}</span></div>
                              <div>Compute: <span className="text-slate-800">{leg.computeUnits ? `${leg.computeUnits.toLocaleString()} CU` : '—'}</span></div>
                              <div>Tx Size: <span className="text-slate-800">{leg.txSizeBytes ? `${leg.txSizeBytes} B` : '—'}</span></div>
                              <div>Venue: <span className="text-slate-800">{leg.routeType || leg.venue || '—'}</span></div>
                            </div>

                            <div className="flex justify-between items-center text-slate-600 text-[10px] font-mono">
                              <span>Exec: ${leg.executablePrice?.toFixed(2) || leg.summary?.executablePrice?.toFixed(2) || '—'}</span>
                              <span>Mark: ${leg.markPrice?.toFixed(2) || leg.summary?.markPrice?.toFixed(2) || '—'} ({leg.markAgeSeconds ?? 0}s old)</span>
                              <span className={(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0) > 5 ? 'text-rose-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                                {(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0) >= 0 ? '+' : ''}{(leg.premiumPct ?? leg.summary?.premiumVsMarkPct ?? 0).toFixed(1)}%
                              </span>
                            </div>

                            {leg.warnings && leg.warnings.length > 0 && (
                              <div className="text-[11px] text-amber-800 bg-amber-50 p-2 rounded-lg border border-amber-200/80">
                                <span className="font-semibold">Guard notice: </span>
                                {leg.warnings.some((w: string) => w.toLowerCase().includes('exit cost'))
                                  ? 'Selling back right now would cost more than usual'
                                  : leg.warnings.some((w: string) => w.toLowerCase().includes('pool impact'))
                                  ? 'Minor caution, likely not a real issue'
                                  : cleanReasons(leg.warnings)}
                                <div className="text-[10px] text-amber-700/80 mt-0.5">{cleanReasons(leg.warnings)}</div>
                              </div>
                            )}

                            {leg.err && (
                              <div className="text-[10px] text-rose-700 bg-rose-50 p-2 rounded-lg border border-rose-200">
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
                            className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold transition cursor-pointer text-xs shadow-2xs"
                          >
                            Close Dry Run
                          </button>
                        ) : secondsUntilExpiry <= 0 ? (
                          <button
                            onClick={() => handleInitiateBasketBuy(userConfirmedWarn)}
                            className="w-full py-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold transition cursor-pointer text-xs"
                          >
                            Blockhash Expired — Re-quote Basket
                          </button>
                        ) : preparedBasket.requiresExplicitConfirm ? (
                          <button
                            disabled={isReverifying}
                            onClick={() => handleInitiateBasketBuy(true)}
                            className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold transition flex items-center justify-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed cursor-pointer text-xs shadow-2xs"
                          >
                            {isReverifying ? (
                              <>
                                <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                                <span>Re-verifying Basket...</span>
                              </>
                            ) : (
                              <span>Confirm Warning & Re-verify Basket</span>
                            )}
                          </button>
                        ) : (
                          <button
                            onClick={handleConfirmAndSignBasket}
                            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold transition flex items-center justify-center gap-2 cursor-pointer text-xs shadow-2xs"
                          >
                            <span>Proceed to Sign Basket in Phantom</span>
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setBuyStep('IDLE');
                            setIsBasketMode(false);
                          }}
                          className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition cursor-pointer text-xs font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : preparedSwap ? (
                    /* Single Token Breakdown */
                    <div className="space-y-4">
                      {/* Venue Name and Status */}
                      <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between">
                        <div>
                          <span className="text-[10px] text-slate-500 uppercase font-medium block">Trading Venue</span>
                          <span className="text-slate-900 font-semibold text-sm">
                            {preparedSwap.summary?.routeType || 'Meteora DLMM'}
                          </span>
                        </div>
                        <div>
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider border ${
                              preparedSwap.summary?.venueStatus === 'VERIFIED'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-rose-50 text-rose-700 border-rose-200'
                            }`}
                          >
                            {preparedSwap.summary?.venueStatus === 'VERIFIED' ? 'Verified Venue' : 'Unverified Venue'}
                          </span>
                        </div>
                      </div>

                      {/* Guard Warnings if any */}
                      {preparedSwap.warnings && preparedSwap.warnings.length > 0 && (
                        <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200/80 text-amber-900 text-xs space-y-1">
                          <div className="font-semibold text-xs text-amber-900 flex items-center gap-1.5">
                            <span>
                              {cleanReasons(preparedSwap.warnings).toLowerCase().includes('exit cost')
                                ? 'Selling back right now would cost more than usual'
                                : cleanReasons(preparedSwap.warnings).toLowerCase().includes('pool impact')
                                ? 'Minor caution, likely not a real issue'
                                : 'Guard Warning Notice'}
                            </span>
                          </div>
                          <div className="text-[11px] text-amber-800 leading-relaxed pt-0.5">{cleanReasons(preparedSwap.warnings)}</div>
                        </div>
                      )}

                      {/* Swap Breakdown Table */}
                      <div className="space-y-2.5 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                        <div className="flex justify-between text-slate-600">
                          <span>USDC Spend (Hard Capped):</span>
                          <span className="text-slate-900 font-semibold font-mono">${(preparedSwap.summary?.spendUsdc ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>Executable Price:</span>
                          <span className="text-slate-900 font-semibold font-mono">${(preparedSwap.summary?.executablePrice ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>PreStocks Mark Price:</span>
                          <span className="text-slate-700 font-mono">${(preparedSwap.summary?.markPrice ?? 0).toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between text-slate-600">
                          <span>Valuation Markup:</span>
                          <span className={(preparedSwap.summary?.premiumVsMarkPct ?? 0) > 5 ? 'text-rose-600 font-semibold font-mono' : 'text-emerald-700 font-semibold font-mono'}>
                            {(preparedSwap.summary?.premiumVsMarkPct ?? 0) >= 0 ? '+' : ''}{(preparedSwap.summary?.premiumVsMarkPct ?? 0).toFixed(1)}%
                          </span>
                        </div>
                        <div className="pt-2 border-t border-slate-200/80 flex justify-between text-slate-800 font-medium">
                          <span>Expected Net Tokens:</span>
                          <span className="text-emerald-700 font-semibold font-mono">
                            {(preparedSwap.summary?.expectedNetTokens ?? 0).toFixed(6)} {preparedSwap.summary?.symbol || ''}
                          </span>
                        </div>
                        <div className="flex justify-between text-slate-600 text-[11px]">
                          <span>Guaranteed Minimum (Slippage + Fee):</span>
                          <span className="text-slate-700 font-mono">
                            {(preparedSwap.summary?.minReceivedTokens ?? 0).toFixed(6)}
                          </span>
                        </div>
                        {preparedSwap.summary?.feeNote && (
                          <div className="text-[11px] text-slate-600 pt-1.5 border-t border-slate-200/60">
                            {preparedSwap.summary.feeNote}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="pt-2 flex flex-col sm:flex-row items-center gap-2.5">
                        {preparedSwap.requiresExplicitConfirm ? (
                          <button
                            disabled={isReverifying}
                            onClick={() => handleInitiateBuy(activeBuyToken!, true)}
                            className="w-full py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold transition flex items-center justify-center gap-2 disabled:opacity-75 disabled:cursor-not-allowed cursor-pointer text-xs shadow-2xs"
                          >
                            {isReverifying ? (
                              <>
                                <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                                <span>Re-verifying with Safety Guards...</span>
                              </>
                            ) : (
                              <span>Confirm Warning & Re-verify</span>
                            )}
                          </button>
                        ) : preparedSwap.isDemo ? (
                          <button
                            onClick={() => setBuyStep('IDLE')}
                            className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold transition cursor-pointer text-xs shadow-2xs"
                          >
                            Close Demo Preview
                          </button>
                        ) : (
                          <button
                            onClick={handleConfirmAndSign}
                            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold transition flex items-center justify-center gap-2 cursor-pointer text-xs shadow-2xs"
                          >
                            <span>Proceed to Sign in Phantom</span>
                          </button>
                        )}
                        <button
                          onClick={() => setBuyStep('IDLE')}
                          className="w-full sm:w-auto px-4 py-2.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition cursor-pointer text-xs font-medium"
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
                  <div className="inline-block h-8 w-8 border-2 border-slate-200 border-t-indigo-600 rounded-full animate-spin"></div>
                  <div className="text-slate-900 font-semibold text-sm">
                    Waiting for manual approval in Phantom wallet...
                  </div>
                  <div className="text-xs text-slate-600">
                    Check your Phantom extension window to review and sign.
                  </div>
                </div>
              )}

              {/* Step: CONFIRMING_TX */}
              {buyStep === 'CONFIRMING_TX' && (
                <div className="py-8 text-center space-y-3">
                  <div className="inline-block h-8 w-8 border-2 border-slate-200 border-t-emerald-600 rounded-full animate-spin"></div>
                  <div className="text-slate-900 font-semibold text-sm">
                    Transaction broadcast to Solana network...
                  </div>
                  <div className="text-xs text-slate-600">
                    Polling confirmation statuses via secure RPC proxy
                  </div>
                </div>
              )}

              {/* Step: SUCCESS (Receipt) */}
              {buyStep === 'SUCCESS' && (swapReceipt || basketReceipts.length > 0) && (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs font-medium">
                    {isBasketMode ? `${basketReceipts.length} basket legs successfully confirmed on Solana mainnet!` : 'Swap transaction successfully confirmed on Solana mainnet!'}
                  </div>

                  {isBasketMode && basketReceipts.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {basketReceipts.map((rcpt) => (
                        <div key={rcpt.signature} className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
                          <div className="flex justify-between items-center">
                            <span className="font-semibold text-slate-900">{rcpt.symbol}</span>
                            <span className="text-slate-900 font-mono font-semibold">${rcpt.amountUsdc.toFixed(2)} USDC</span>
                          </div>
                          <div className="flex justify-between text-slate-600 text-[11px]">
                            <span>Delivered:</span>
                            <span className="text-slate-800 font-mono font-semibold">~{rcpt.expectedNetTokens.toFixed(6)} tokens</span>
                          </div>
                          <div className="pt-1 border-t border-slate-200/60">
                            <a
                              href={rcpt.solscanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-emerald-700 hover:underline font-mono text-[11px] break-all block"
                            >
                              Tx: {rcpt.signature.slice(0, 16)}...{rcpt.signature.slice(-8)} ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : swapReceipt ? (
                    <div className="space-y-2 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                      <div className="flex justify-between text-slate-600">
                        <span>Token Swapped:</span>
                        <span className="text-slate-900 font-semibold">{swapReceipt.symbol}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>USDC Spent:</span>
                        <span className="text-slate-900 font-mono font-semibold">${swapReceipt.amountUsdc.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>Quoted Expected Tokens:</span>
                        <span className="text-slate-800 font-mono">{swapReceipt.expectedNetTokens.toFixed(6)}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>Actual Tokens Received:</span>
                        <span className="text-emerald-700 font-semibold font-mono">
                          {swapReceipt.actualTokensReceived !== null ? swapReceipt.actualTokensReceived.toFixed(6) : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>Diff (Actual vs Quoted):</span>
                        <span className={`font-mono font-semibold ${
                          (swapReceipt.diffTokens ?? 0) >= 0 ? 'text-emerald-700' : 'text-amber-700'
                        }`}>
                          {swapReceipt.diffTokens !== null && swapReceipt.diffTokens !== undefined
                            ? `${swapReceipt.diffTokens >= 0 ? '+' : ''}${swapReceipt.diffTokens.toFixed(6)}`
                            : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between text-slate-600 text-[11px]">
                        <span>Quoted Minimum:</span>
                        <span className="text-slate-700 font-mono">{swapReceipt.minTokens.toFixed(6)}</span>
                      </div>
                      <div className="pt-2 border-t border-slate-200/80 flex flex-col gap-1">
                        <span className="text-slate-600 text-[11px]">Solscan Explorer Link:</span>
                        <a
                          href={swapReceipt.solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-700 hover:underline font-mono text-[11px] break-all"
                        >
                          {swapReceipt.signature} ↗
                        </a>
                      </div>
                      <div className="text-[11px] text-slate-600 pt-1 border-t border-slate-200/60">
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
                    className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold transition cursor-pointer text-xs shadow-2xs"
                  >
                    Done
                  </button>
                </div>
              )}

              {/* Step: TIMEOUT (Status Unknown) */}
              {buyStep === 'TIMEOUT' && (swapReceipt || basketReceipts.length > 0) && (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-xs">
                    <span className="font-semibold">Status Unknown:</span> Confirmation timed out after 30 seconds. Neither success nor failure is claimed.
                  </div>

                  {isBasketMode && basketReceipts.length > 0 ? (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {basketReceipts.map((rcpt) => (
                        <div key={rcpt.signature} className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-xs space-y-1">
                          <div className="flex justify-between items-center">
                            <span className="font-semibold text-slate-900">{rcpt.symbol}</span>
                            <span className="text-slate-900 font-mono font-semibold">${rcpt.amountUsdc.toFixed(2)} USDC</span>
                          </div>
                          <div className="pt-1 border-t border-slate-200/60">
                            <a
                              href={rcpt.solscanUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-emerald-700 hover:underline font-mono text-[11px] break-all block"
                            >
                              Check Solscan: {rcpt.signature.slice(0, 16)}...{rcpt.signature.slice(-8)} ↗
                            </a>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : swapReceipt ? (
                    <div className="space-y-2 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
                      <div className="flex justify-between text-slate-600">
                        <span>Token Swapped:</span>
                        <span className="text-slate-900 font-semibold">{swapReceipt.symbol}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>USDC Committed:</span>
                        <span className="text-slate-900 font-mono font-semibold">${swapReceipt.amountUsdc.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-slate-600">
                        <span>Quoted Tokens:</span>
                        <span className="text-slate-800 font-mono">{swapReceipt.expectedNetTokens.toFixed(6)}</span>
                      </div>
                      <div className="pt-2 border-t border-slate-200/80 flex flex-col gap-1">
                        <span className="text-slate-600 text-[11px]">Check Solscan to verify transaction outcome:</span>
                        <a
                          href={swapReceipt.solscanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-emerald-700 hover:underline font-mono text-[11px] break-all"
                        >
                          {swapReceipt.solscanUrl} ↗
                        </a>
                      </div>
                      <div className="text-[11px] text-amber-800 pt-1 border-t border-slate-200/60">
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
                    className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold transition cursor-pointer text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Step: ERROR */}
              {buyStep === 'ERROR' && (
                <div className="space-y-4">
                  <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-900 text-xs">
                    <span className="font-semibold">Trade Halted:</span> {buyError || 'An error occurred during trade preparation.'}
                  </div>

                  <button
                    onClick={() => {
                      setBuyStep('IDLE');
                      setBuyError(null);
                    }}
                    className="w-full py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white font-semibold transition cursor-pointer text-xs"
                  >
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
