import { ConversationsClient } from '@/components/conversations/ConversationsClient';

export const dynamic = 'force-dynamic';

/**
 * §7.1 — one view, no list filtering.
 *
 * Lead lists are no longer fetched here because they are no longer a filter
 * dimension. An import still records which file a lead came from, for
 * provenance, but "which spreadsheet was this" is not a question anybody works
 * along.
 */
export default function ConversationsPage() {
  return <ConversationsClient />;
}
