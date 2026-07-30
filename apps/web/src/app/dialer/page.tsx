import { db } from '@/lib/db';
import { loadBoard } from '@/lib/board';
import { DialerClient } from './DialerClient';

export const dynamic = 'force-dynamic';

/**
 * Dialer settings (gap delay, audio mode) are no longer read here — they are
 * owned by <CallProvider> in the root layout, which needs them whether or not
 * the operator is currently looking at this page (§3.3).
 */
export default async function DialerPage() {
  const [leadCount, board, lists, customFields] = await Promise.all([
    db.contact.count({ where: { pipelineRemovedAt: null } }),
    loadBoard(),
    db.leadList.findMany({
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { contacts: true } } },
    }),
    db.customField.findMany({
      where: { showOnCard: true },
      orderBy: { position: 'asc' },
      select: { id: true, label: true },
    }),
  ]);

  return (
    <DialerClient
      leadCount={leadCount}
      board={board}
      lists={lists.map((l) => ({
        id: l.id,
        name: l.name,
        count: l._count.contacts,
      }))}
      visibleCustomFields={customFields}
    />
  );
}
