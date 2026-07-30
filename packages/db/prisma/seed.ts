/**
 * Seeds the minimum an operator needs to start dialing on a fresh clone:
 * one pipeline with a sensible cold-call stage set.
 *
 * Safe to re-run — it no-ops if a pipeline already exists.
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const DEFAULT_STAGES = [
  { name: 'New', color: '#64748b' },
  { name: 'Contacted', color: '#3b82f6' },
  { name: 'Callback', color: '#f59e0b' },
  { name: 'Booked', color: '#22c55e' },
  { name: 'Not Interested', color: '#ef4444' },
];

async function main() {
  const existing = await db.pipeline.count();
  if (existing > 0) {
    console.log('Pipeline already exists — nothing to seed.');
    return;
  }

  const pipeline = await db.pipeline.create({
    data: {
      name: 'Cold Outbound',
      isDefault: true,
      position: 0,
      stages: {
        create: DEFAULT_STAGES.map((s, i) => ({ ...s, position: i })),
      },
    },
    include: { stages: true },
  });

  console.log(
    `Seeded pipeline "${pipeline.name}" with ${pipeline.stages.length} stages.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
