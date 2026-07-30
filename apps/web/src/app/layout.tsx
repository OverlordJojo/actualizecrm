import type { Metadata, Viewport } from 'next';
import './globals.css';
import { LeftRail } from '@/components/LeftRail';

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
        <div className="flex h-screen w-screen overflow-hidden">
          <LeftRail />
          <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
