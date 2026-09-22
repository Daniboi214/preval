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
    <html lang="en" className="dark">
      <body className="min-h-screen bg-[#0a0a0c] text-[#f4f4f6] selection:bg-[#14f195] selection:text-black">
        <SolanaWalletProvider>
          {children}
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
