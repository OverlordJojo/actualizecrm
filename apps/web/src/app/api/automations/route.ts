import { NextResponse } from 'next/server';
import { validateAutomation } from '@/lib/automation-validation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { TRIGGER_TYPES, STEP_TYPES } from '@/lib/automations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const stepSchema = z.object({
  type: z.enum(STEP_TYPES),
  seconds: z.number().int().min(0).optional(),
  templateId: z.string().optional(),
  recordingId: z.string().optional(),
  tag: z.string().optional(),
  stageId: z.string().optional(),
  dueInMinutes: z.number().int().min(1).optional(),
  note: z.string().optional(),
});

/// Hidden bookkeeping row that owns housekeeping runs; never an automation the
/// operator made, so it never appears in the list.
const SYSTEM_NAME = '__system__';

export async function GET() {
  const automations = await db.automation.findMany({
    where: { NOT: { name: SYSTEM_NAME } },
    orderBy: { createdAt: 'desc' },
    include: {
      _count: { select: { runs: true } },
    },
  });

  return NextResponse.json(automations);
}

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give the automation a name.').max(120),
  triggerType: z.enum(TRIGGER_TYPES),
  triggerConfig: z.record(z.unknown()).default({}),
  steps: z.array(stepSchema).default([]),
  enabled: z.boolean().default(false),
});

export async function POST(request: Request) {
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid automation.' },
      { status: 400 },
    );
  }

  // §8.2 — an automation that cannot possibly work is not savable. The failure
  // it would otherwise produce arrives hours later as a dead job the operator
  // can do nothing with, by which time the follow-up has not gone out.
  const problems = await validateAutomation({
    trigger: parsed.data.triggerType,
    steps: parsed.data.steps as { type: string; config?: Record<string, unknown> }[],
  });
  if (problems.length > 0) {
    return NextResponse.json({ problems }, { status: 422 });
  }

  const created = await db.automation.create({
    data: {
      name: parsed.data.name,
      triggerType: parsed.data.triggerType,
      triggerConfig: parsed.data.triggerConfig as never,
      steps: parsed.data.steps as never,
      // New automations start switched off. An automation that begins sending
      // the instant it is saved gives the operator no chance to read it back.
      enabled: false,
    },
  });

  return NextResponse.json(created, { status: 201 });
}
