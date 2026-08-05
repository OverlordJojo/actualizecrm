import { NextResponse } from 'next/server';
import { validateAutomation } from '@/lib/automation-validation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { TRIGGER_TYPES, STEP_TYPES } from '@/lib/automations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RUN_LIMIT = 50;

/// The automation plus its recent runs — the run log the spec asks every
/// automation to carry.
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const automation = await db.automation.findUnique({
    where: { id: params.id },
    include: {
      runs: {
        orderBy: { createdAt: 'desc' },
        take: RUN_LIMIT,
        include: {
          contact: {
            select: { id: true, firstName: true, lastName: true, phone: true },
          },
        },
      },
    },
  });

  if (!automation) {
    return NextResponse.json({ error: 'Automation not found.' }, { status: 404 });
  }

  return NextResponse.json(automation);
}

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

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  triggerType: z.enum(TRIGGER_TYPES).optional(),
  triggerConfig: z.record(z.unknown()).optional(),
  steps: z.array(stepSchema).optional(),
  enabled: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  // §8.2 — the same gate as creation. An automation must not be switched on
  // into a state where it can only fail.
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid automation.' }, { status: 400 });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.triggerType !== undefined) data.triggerType = parsed.data.triggerType;
  if (parsed.data.triggerConfig !== undefined) data.triggerConfig = parsed.data.triggerConfig;
  if (parsed.data.steps !== undefined) data.steps = parsed.data.steps;
  if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;

  const updated = await db.automation.update({ where: { id: params.id }, data });
  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  // Runs cascade with the automation. Keeping orphaned run rows would leave the
  // run log showing history for something the operator can no longer open.
  await db.automation.delete({ where: { id: params.id } }).catch(() => {});
  return NextResponse.json({ deleted: true });
}
