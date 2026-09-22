import { NextResponse } from 'next/server';
import { prepareSingleTokenSwap, ALLOWED_SYMBOLS } from '@/src/dataLayer.js';

export { ALLOWED_SYMBOLS };

export async function POST(req: Request) {
  try {
    const rawBody = await req.json();

    // Whitelist ONLY the 7 browser-permitted fields; discard any injected overrides
    const {
      symbol,
      amountUsdc,
      userPublicKey,
      confirmWarn,
      maxPremium,
      maxPriceImpact,
      warnExitLoss
    } = rawBody || {};

    const result = await prepareSingleTokenSwap({
      symbol,
      amountUsdc,
      userPublicKey,
      confirmWarn,
      maxPremium,
      maxPriceImpact,
      warnExitLoss
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to assemble swap transaction' },
      { status: 500 }
    );
  }
}
