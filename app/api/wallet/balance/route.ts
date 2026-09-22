import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import { USDC_MINT, DEFAULT_RPC_URL } from '@/src/dataLayer.js';

function getRpcUrl(): string {
  let rpc = process.env.SOLANA_RPC_URL;
  if (!rpc || rpc.includes('PASTE_YOUR_KEY_HERE')) {
    try {
      const envPath = path.join(process.cwd(), '.env.local');
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf8');
        const match = content.match(/^\s*(?:SOLANA_RPC_URL\s*=\s*)?([^\r\n]+)/m);
        if (match) {
          const parsed = match[1].trim().replace(/^["']|["']$/g, '');
          if (parsed && !parsed.includes('PASTE_YOUR_KEY_HERE') && !parsed.startsWith('ENABLE_REAL_BUY')) {
            rpc = parsed;
          }
        }
      }
    } catch {
      // Ignore file reading errors
    }
  }

  return rpc && !rpc.includes('PASTE_YOUR_KEY_HERE') ? rpc : DEFAULT_RPC_URL;
}

export async function POST(req: Request) {
  try {
    const { address } = await req.json();
    if (!address) {
      return NextResponse.json({ error: 'Missing address parameter' }, { status: 400 });
    }

    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      return NextResponse.json({ error: 'Invalid Solana address' }, { status: 400 });
    }

    const rpcUrl = getRpcUrl();
    const connection = new Connection(rpcUrl, 'confirmed');

    // Fetch native SOL balance
    const solLamports = await connection.getBalance(pubkey);
    const solBalance = solLamports / 1e9;

    // Fetch USDC balance
    let usdcBalance = 0;
    try {
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
        mint: new PublicKey(USDC_MINT)
      });

      if (tokenAccounts.value && tokenAccounts.value.length > 0) {
        for (const ta of tokenAccounts.value) {
          const amount = ta.account.data.parsed.info.tokenAmount.uiAmount || 0;
          usdcBalance += amount;
        }
      }
    } catch {
      // If user has no USDC ATA yet, balance is 0
      usdcBalance = 0;
    }

    return NextResponse.json({
      address: pubkey.toBase58(),
      solBalance: Number(solBalance.toFixed(4)),
      usdcBalance: Number(usdcBalance.toFixed(2))
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'Failed to fetch wallet balances' },
      { status: 500 }
    );
  }
}
