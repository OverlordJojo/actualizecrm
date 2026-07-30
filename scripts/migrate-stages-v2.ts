/**
 * §1.2 — replace the v1 default stage set.
 *
 *   npx tsx scripts/migrate-stages-v2.ts
 *
 * v1:  Unassigned (implicit) · New · Contacted · Callback · Booked · Not Interested
 * v2:  New · Callback · Interested · Booked
 *
 * Mapping:
 *   Unassigned (stageId null) -> New
 *   Contacted                 -> New
 *   Not Interested            -> soft-removed per §1.3, not deleted
 *   New / Callback / Booked   -> kept
 *   Interested                -> created
 *
 * Idempotent: safe to re-run.
 */
import { db } from '@actualizecrm/db';

const TARGET = [
  { name: 'New', color: '#64748b' },
  { name: 'Callback', color: '#f59e0b' },
  { name: 'Interested', color: '#3b82f6' },
  { name: 'Booked', color: '#22c55e' },
];

async function main() {
  const pipelines = await db.pipeline.findMany({
    include: { stages: { orderBy: { position: 'asc' } } },
  });

  if (pipelines.length === 0) {
    console.log('No pipelines — run npm run db:seed first.');
    return;
  }

  for (const pipeline of pipelines) {
    console.log(`\nPipeline "${pipeline.name}"`);
    const byName = new Map(pipeline.stages.map((s) => [s.name, s]));

    // 1. Ensure the four target stages exist, in order.
    for (const [i, want] of TARGET.entries()) {
      const existing = byName.get(want.name);
      if (existing) {
        await db.pipelineStage.update({
          where: { id: existing.id },
          data: { position: i, color: want.color },
        });
        console.log(`  kept    ${want.name} (position ${i})`);
      } else {
        const created = await db.pipelineStage.create({
          data: {
            pipelineId: pipeline.id,
            name: want.name,
            color: want.color,
            position: i,
          },
        });
        byName.set(want.name, created);
        console.log(`  created ${want.name} (position ${i})`);
      }
    }

    const newStage = byName.get('New')!;

    // 2. Contacted -> New
    const contacted = byName.get('Contacted');
    if (contacted) {
      const moved = await db.contact.updateMany({
        where: { stageId: contacted.id },
        data: { stageId: newStage.id },
      });
      await db.pipelineStage.delete({ where: { id: contacted.id } });
      console.log(`  merged  Contacted -> New (${moved.count} leads)`);
    }

    // 3. Not Interested -> soft-removed. The leads keep their history and stay
    //    searchable; they simply leave the board.
    const notInterested = byName.get('Not Interested');
    if (notInterested) {
      const affected = await db.contact.findMany({
        where: { stageId: notInterested.id },
        select: { id: true },
      });

      if (affected.length) {
        await db.contact.updateMany({
          where: { stageId: notInterested.id },
          data: {
            stageId: null,
            pipelineRemovedAt: new Date(),
            removalReason: 'not_interested',
          },
        });
        await db.activity.createMany({
          data: affected.map((c) => ({
            contactId: c.id,
            type: 'stage_change',
            summary: 'Removed from pipeline — not interested',
            meta: { migratedFrom: 'Not Interested stage' } as never,
          })),
        });
      }

      await db.pipelineStage.delete({ where: { id: notInterested.id } });
      console.log(
        `  removed Not Interested stage (${affected.length} leads soft-removed)`,
      );
    }
  }

  // 4. Unassigned leads land in New. §1.2 replaces the Unassigned column
  //    entirely — every imported lead now starts in a real stage.
  const defaultPipeline =
    (await db.pipeline.findFirst({ where: { isDefault: true } })) ??
    (await db.pipeline.findFirst());

  const defaultNew = await db.pipelineStage.findFirst({
    where: { pipelineId: defaultPipeline!.id, name: 'New' },
  });

  const orphans = await db.contact.updateMany({
    where: { stageId: null, pipelineRemovedAt: null },
    data: { stageId: defaultNew!.id },
  });
  console.log(`\nUnassigned -> New: ${orphans.count} leads`);

  const summary = await db.pipelineStage.findMany({
    where: { pipelineId: defaultPipeline!.id },
    orderBy: { position: 'asc' },
    include: { _count: { select: { contacts: true } } },
  });
  console.log('\nFinal board:');
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(12)} ${s._count.contacts} leads`);
  }
  const removed = await db.contact.count({
    where: { NOT: { pipelineRemovedAt: null } },
  });
  console.log(`  ${'(removed)'.padEnd(12)} ${removed} leads`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
