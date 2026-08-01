import { db } from '@/lib/db';
import { ConversationsClient } from '@/components/conversations/ConversationsClient';

export const dynamic = 'force-dynamic';

export default async function ConversationsPage() {
  // Lists are small, stable, and needed to render the filter bar — fetching
  // them on the server keeps the page from flashing an empty dropdown.
  const lists = await db.leadList.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true },
  });

  return <ConversationsClient lists={lists} />;
}
