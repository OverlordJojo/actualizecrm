'use client';

import { useCall } from '@/components/call/CallProvider';
import { ContactSlideOver } from '@/components/contact/ContactSlideOver';

/**
 * Opens the contact slide-over automatically when an inbound call rings
 * (add-on A).
 *
 * Mounted inside `CallProvider` in the app shell rather than on the Dialer
 * page, because the operator is often on Conversations or Calendar when the
 * phone rings, and a screen-pop that only works on one page is a screen-pop
 * that mostly does not work.
 */
export function ScreenPop() {
  const call = useCall();

  return (
    <ContactSlideOver
      contactId={call.screenPopContactId}
      onClose={call.clearScreenPop}
    />
  );
}
