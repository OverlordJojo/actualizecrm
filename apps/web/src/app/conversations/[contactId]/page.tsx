import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { ContactThread } from '@/components/conversations/ContactThread';

export const dynamic = 'force-dynamic';

/**
 * A contact's whole history, as a full page (§7.4).
 *
 * A page rather than a side panel. The timeline is the thing being read — it
 * can run to hundreds of messages and a recording the operator wants to scrub
 * through — and a panel that covers half of it while the other half stays
 * visible behind serves neither.
 */
export default async function ContactThreadPage({
  params,
}: {
  params: { contactId: string };
}) {
  const contact = await db.contact.findUnique({
    where: { id: params.contactId },
    include: {
      stage: { select: { id: true, name: true, color: true } },
      tags: { include: { tag: true } },
    },
  });
  if (!contact) notFound();

  const [activities, calls, messages, emails, stages] = await Promise.all([
    db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'asc' },
      take: 500,
    }),
    db.call.findMany({
      where: { contactId: contact.id },
      orderBy: { startedAt: 'asc' },
      select: {
        id: true, startedAt: true, direction: true, durationSec: true,
        disposition: true, recordingPath: true, transcript: true, status: true,
      },
    }),
    db.message.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'asc' },
    }).catch(() => []),
    db.emailMessage.findMany({
      where: { contactId: contact.id },
      orderBy: { createdAt: 'asc' },
    }).catch(() => []),
    db.pipelineStage.findMany({
      orderBy: { position: 'asc' },
      select: { id: true, name: true, color: true },
    }),
  ]);

  return (
    <ContactThread
      contact={{
        id: contact.id,
        firstName: contact.firstName,
        lastName: contact.lastName,
        jobTitle: contact.jobTitle,
        companyName: contact.companyName,
        companyLocation: contact.companyLocation,
        phone: contact.phone,
        email: contact.email,
        address: contact.address,
        stageId: contact.stageId,
        stageName: contact.stage?.name ?? null,
        removed: contact.pipelineRemovedAt !== null,
        tags: contact.tags.map((t) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color })),
      }}
      stages={stages}
      items={buildTimeline({ activities, calls, messages, emails })}
    />
  );
}

/**
 * Merges every channel into one chronological stream (§7.4).
 *
 * Built here rather than in the client because the four sources have nothing in
 * common but a timestamp, and reconciling them in the browser would mean
 * shipping four arrays and sorting them on every render.
 */
function buildTimeline({
  activities,
  calls,
  messages,
  emails,
}: {
  activities: any[];
  calls: any[];
  messages: any[];
  emails: any[];
}) {
  const items: any[] = [];

  for (const c of calls) {
    items.push({
      kind: 'call',
      id: `call-${c.id}`,
      at: c.startedAt,
      outbound: c.direction !== 'inbound',
      callId: c.id,
      durationSec: c.durationSec,
      disposition: c.disposition,
      status: c.status,
      hasRecording: Boolean(c.recordingPath),
      transcript: c.transcript,
    });
  }

  for (const m of messages) {
    items.push({
      kind: 'sms',
      id: `sms-${m.id}`,
      at: m.createdAt,
      outbound: m.direction !== 'inbound',
      body: m.body,
    });
  }

  for (const e of emails) {
    items.push({
      kind: 'email',
      id: `email-${e.id}`,
      at: e.createdAt,
      outbound: e.direction !== 'inbound',
      subject: e.subject,
      body: e.body,
    });
  }

  // Notes are centred annotations, not messages from either side, so only the
  // note-shaped activities come through. Everything else is already represented
  // by the row it describes.
  for (const a of activities) {
    if (a.type !== 'note') continue;
    items.push({ kind: 'note', id: `note-${a.id}`, at: a.createdAt, body: a.summary });
  }

  return items
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    .map((i) => ({ ...i, at: new Date(i.at).toISOString() }));
}
