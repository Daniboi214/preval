import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PreVal — Guarded PreStocks Basket',
  description: 'Buy the private AI and frontier-tech wave in one click, without overpaying.',
};

import { SolanaWalletProvider } from './components/WalletProvider';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f8fafc] text-[#0f172a] selection:bg-emerald-500 selection:text-white antialiased">
        <SolanaWalletProvider>
          {children}
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
