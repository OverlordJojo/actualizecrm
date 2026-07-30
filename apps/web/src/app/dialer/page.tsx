import { db } from '@/lib/db';
import { loadBoard } from '@/lib/board';
import { getSettings, asNumber, asBool } from '@/lib/settings';
import { DialerClient } from './DialerClient';

export const dynamic = 'force-dynamic';

export default async function DialerPage() {
  const [leadCount, board, lists, customFields, settings] = await Promise.all([
    db.contact.count(),
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
    getSettings(),
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
      gapSeconds={asNumber(settings['dialer.gapDelaySeconds'], 2)}
      audio={{
        mode: asBool(settings['audio.musicInsteadOfRinging'])
          ? 'music'
          : 'ringback',
        ringbackVolume: asNumber(settings['audio.ringbackVolume'], 0.5),
        playlistUri: settings['audio.spotifyPlaylistUri'] || null,
      }}
    />
  );
}
