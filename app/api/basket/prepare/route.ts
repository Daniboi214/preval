import { NextResponse } from 'next/server';
import { prepareBasketSwaps, ALLOWED_SYMBOLS } from '@/src/dataLayer.js';

export { ALLOWED_SYMBOLS };

export async function POST(req: Request) {
  try {
    const rawBody = await req.json();

    // Whitelist ONLY the 7 browser-permitted fields; discard any injected overrides
    const {
      symbols,
      totalUsdc,
      userPublicKey,
      confirmWarn,
      maxPremium,
      maxPriceImpact,
      warnExitLoss
    } = rawBody || {};

    const result = await prepareBasketSwaps({
      symbols,
      totalUsdc,
      userPublicKey,
      confirmWarn,
      maxPremium,
      maxPriceImpact,
      warnExitLoss
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to assemble basket swap transactions' },
      { status: 500 }
    );
  }
}
