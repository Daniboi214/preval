import { NextResponse } from 'next/server';
import { Connection } from '@solana/web3.js';
import {
  DEFAULT_RPC_URL,
  ALLOWED_RPC_METHODS,
  getClientIpFromHeaders,
  handleRpcProxyRequest
} from '@/src/dataLayer.js';

export { ALLOWED_RPC_METHODS };

function getRpcUrl(): string {
  const envRpc = process.env.SOLANA_RPC_URL?.trim();
  if (envRpc && !envRpc.includes('PASTE_YOUR_KEY_HERE')) {
    return envRpc;
  }
  return DEFAULT_RPC_URL;
}

export async function POST(req: Request) {
  try {
    const ip = getClientIpFromHeaders(req.headers);

    // Body size cap: max 50KB (51,200 bytes)
    const rawBody = await req.text();
    if (rawBody.length > 51200) {
      return NextResponse.json({ error: 'Payload Too Large: body exceeds 50KB limit' }, { status: 413 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: 'Malformed JSON payload' }, { status: 400 });
    }

    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    const result = await handleRpcProxyRequest(body, { ip, connection });
    return NextResponse.json(result.body, { status: result.status });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'RPC proxy failure' }, { status: 500 });
  }
}
