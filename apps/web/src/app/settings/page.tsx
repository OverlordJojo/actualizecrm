import { Suspense } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { PhoneNumbers } from '@/components/settings/PhoneNumbers';
import { AudioSettings } from '@/components/settings/AudioSettings';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Numbers, audio, email, messaging, data"
      />
      <div className="scroll-thin flex-1 overflow-y-auto p-5">
        <div className="max-w-3xl space-y-8">
          <PhoneNumbers />

          {/* useSearchParams needs a Suspense boundary in the App Router. */}
          <Suspense
            fallback={<div className="text-xs text-ink-500">Loading audio…</div>}
          >
            <AudioSettings />
          </Suspense>

          {/* Email (step 8), Messaging & A2P (step 9), Dialer / Custom Fields /
              Pipelines / Data (step 10) land with their integrations. */}
        </div>
      </div>
    </>
  );
}
