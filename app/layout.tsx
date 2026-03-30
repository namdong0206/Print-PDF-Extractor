import type {Metadata} from 'next';
import { Inter, Space_Grotesk, Playfair_Display } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-display',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-serif',
});

export const metadata: Metadata = {
  title: 'Phân Loại Box Báo Chí - Báo Nhân Dân',
  description: 'Hệ thống bóc tách và phân tích bố cục báo in Nhân Dân tự động.',
};

export default function RootLayout({children}: {children: React.ReactNode}) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} ${playfair.variable}`}>
      <head>
        <Script 
          src="https://docs.opencv.org/4.10.0/opencv.js" 
          strategy="beforeInteractive"
        />
      </head>
      <body suppressHydrationWarning className="antialiased">{children}</body>
    </html>
  );
}
