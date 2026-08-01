'use client';

import { usePathname } from 'next/navigation';
import { LeftRail } from '@/components/LeftRail';
import { CallProvider } from '@/components/call/CallProvider';
import { MiniCallBar } from '@/components/call/MiniCallBar';
import { ScreenPop } from '@/components/call/ScreenPop';

/**
 * Chooses between the app shell and the bare sign-in page.
 *
 * The authenticated branch is written out once and never varies in shape, so
 * React reconciles `<CallProvider>` to the same position on every navigation
 * and does not remount it. That is the invariant the whole call architecture
 * rests on (§3.3): a remount destroys the WebRTC session and drops whatever
 * call is in progress, mid-conversation.
 *
 * Sign-in is the one route that legitimately has no call state — you are not
 * on a call if you are not signed in — so it renders outside the provider
 * rather than mounting a softphone that can only fail.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (pathname === '/login') {
    return <>{children}</>;
  }

  return (
    <CallProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        <LeftRail />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <MiniCallBar />
          {children}
        </main>
        {/* Inside the provider so an inbound call pops the contact on whatever
            page the operator happens to be on. */}
        <ScreenPop />
      </div>
    </CallProvider>
  );
}
