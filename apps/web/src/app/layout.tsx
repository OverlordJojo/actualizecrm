import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LeftRail } from '@/components/LeftRail';
import { CallProvider } from '@/components/call/CallProvider';
import { MiniCallBar } from '@/components/call/MiniCallBar';

export const metadata: Metadata = {
  title: 'ActualizeCRM',
  description: 'Local-first cold-calling CRM',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'ActualizeCRM',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#0e111a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="h-full">
        {/*
          CallProvider wraps the router outlet and never unmounts, so a live
          call survives navigation between pages. Nothing call-related may be
          moved inside a page — that is what dropped calls in v1.
        */}
        <CallProvider>
          <div className="flex h-screen w-screen overflow-hidden">
            <LeftRail />
            <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
              <MiniCallBar />
              {children}
            </main>
          </div>
        </CallProvider>
      </body>
    </html>
  );
}
