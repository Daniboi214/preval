import './globals.css';
import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { SolanaWalletProvider } from './components/WalletProvider';

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
  weight: ['400', '500', '600'],
});

export const metadata: Metadata = {
  title: 'PreVal — Guarded PreStocks Basket',
  description: 'Buy the private AI and frontier-tech wave in one click, without overpaying.',
  icons: {
    icon: '/icon.svg',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable}>
      <body className={`${inter.className} min-h-screen bg-[#f8fafc] text-[#0f172a] selection:bg-emerald-500 selection:text-white antialiased`}>
        <SolanaWalletProvider>
          {children}
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
