import { Suspense } from 'react';
import { PageHeader } from '@/components/PageHeader';
import { PhoneNumbers } from '@/components/settings/PhoneNumbers';
import { AudioSettings } from '@/components/settings/AudioSettings';
import { VoicemailSettings } from '@/components/settings/VoicemailSettings';
import { EmailSettings } from '@/components/settings/EmailSettings';
import { TemplatesSettings } from '@/components/settings/TemplatesSettings';
import { MessagingSettings } from '@/components/settings/MessagingSettings';
import { CalendarSettings } from '@/components/settings/CalendarSettings';
import { DialerSettings } from '@/components/settings/DialerSettings';
import { DataSettings } from '@/components/settings/DataSettings';
import { CustomFieldsSettings } from '@/components/settings/CustomFieldsSettings';

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

          {/* Reads the OAuth outcome out of the query string, so it needs the
              same Suspense boundary. */}
          <Suspense
            fallback={<div className="text-xs text-ink-500">Loading calendar…</div>}
          >
            <CalendarSettings />
          </Suspense>

          <VoicemailSettings />

          <EmailSettings />

          <MessagingSettings />

          <TemplatesSettings />

          <DialerSettings />

          <CustomFieldsSettings />

          <DataSettings />
        </div>
      </div>
    </>
  );
}
