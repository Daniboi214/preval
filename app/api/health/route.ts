import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
  const rpcConfigured = Boolean(
    rpcUrl &&
    rpcUrl.length > 0 &&
    !rpcUrl.includes('PASTE_YOUR_KEY_HERE')
  );
  const realBuyEnabled = process.env.ENABLE_REAL_BUY?.trim() === 'true';

  const clientIpHeaderPresent = Boolean(
    req.headers.get('x-vercel-forwarded-for')?.trim()
  );

  return NextResponse.json({
    rpcConfigured,
    realBuyEnabled,
    clientIpHeaderPresent
  });
}
