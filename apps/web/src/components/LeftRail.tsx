'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';

/// The app has exactly four top-level destinations. Lead import is a modal on
/// the Dialer page and contact detail is a slide-over — neither gets a nav
/// entry, and nothing else should be added here.
const NAV = [
  { href: '/dialer', label: 'Dialer', icon: PhoneIcon },
  { href: '/conversations', label: 'Conversations', icon: InboxIcon },
  { href: '/automations', label: 'Automations', icon: BoltIcon },
  { href: '/settings', label: 'Settings', icon: GearIcon },
] as const;

export function LeftRail() {
  const pathname = usePathname();

  return (
    <nav className="flex h-full w-[76px] shrink-0 flex-col items-center gap-1 border-r border-ink-800 bg-ink-900 py-4">
      <Link href="/dialer" className="mb-4 block" title="ActualizeCRM">
        <Image
          src="/icon-192.png"
          alt="ActualizeCRM"
          width={34}
          height={34}
          priority
        />
      </Link>

      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            title={label}
            className={cn(
              'group flex w-[60px] flex-col items-center gap-1 rounded-lg px-1 py-2.5 transition-colors',
              active
                ? 'bg-ink-800 text-brand-400'
                : 'text-ink-400 hover:bg-ink-850 hover:text-ink-200',
            )}
          >
            <Icon className="h-[22px] w-[22px]" />
            <span className="text-[10px] font-medium leading-none">{label}</span>
          </Link>
        );
      })}

      <button
        onClick={async () => {
          await fetch('/api/auth/logout', { method: 'POST' });
          // Full reload so the softphone and any in-memory call state go with
          // the session rather than lingering on an unauthenticated page.
          window.location.href = '/login';
        }}
        title="Sign out"
        className="mt-auto flex w-[60px] flex-col items-center gap-1 rounded-lg px-1 py-2.5 text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-200"
      >
        <SignOutIcon className="h-[22px] w-[22px]" />
        <span className="text-[10px] font-medium leading-none">Sign out</span>
      </button>
    </nav>
  );
}

// Inline SVGs rather than an icon package — four icons is not worth a
// dependency, and these inherit currentColor cleanly.

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
    </svg>
  );
}

function InboxIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1Z" />
    </svg>
  );
}

function BoltIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
    </svg>
  );
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}

function GearIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 3.7 9a1.7 1.7 0 0 0-.4-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H8a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}
