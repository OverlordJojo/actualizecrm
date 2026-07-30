import { db } from '@/lib/db';
import type { BoardData, BoardLead } from '@/components/pipeline/types';

const LEAD_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  companyName: true,
  companyLocation: true,
  phone: true,
  dealValue: true,
  lastDisposition: true,
  stageId: true,
  stagePosition: true,
} as const;

/**
 * Loads one pipeline's board: its stages with their leads, plus every lead
 * that has no stage yet.
 *
 * Unassigned is global rather than per-pipeline because a lead has a single
 * stageId — a freshly imported lead belongs to no pipeline in particular, and
 * hiding it would make an import look like it silently did nothing.
 */
export async function loadBoard(pipelineId?: string): Promise<BoardData | null> {
  const pipelines = await db.pipeline.findMany({
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, name: true },
  });

  if (pipelines.length === 0) return null;

  const active =
    pipelines.find((p) => p.id === pipelineId)?.id ?? pipelines[0].id;

  const stages = await db.pipelineStage.findMany({
    where: { pipelineId: active },
    orderBy: { position: 'asc' },
    include: {
      contacts: {
        // Removed leads leave the board entirely (§1.3). They remain
        // searchable on Conversations under the Removed filter.
        where: { pipelineRemovedAt: null },
        orderBy: [{ stagePosition: 'asc' }, { updatedAt: 'desc' }],
        select: LEAD_SELECT,
      },
    },
  });

  // v2 removed the Unassigned column — every lead now lands in New on import
  // (§1.2). Anything still stage-less and not removed is a data anomaly rather
  // than a normal state, so surface it instead of hiding it.
  const unassigned = await db.contact.findMany({
    where: { stageId: null, pipelineRemovedAt: null },
    orderBy: { createdAt: 'desc' },
    select: LEAD_SELECT,
  });

  return {
    pipelines,
    activePipelineId: active,
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      position: s.position,
      leads: s.contacts as BoardLead[],
    })),
    unassigned: unassigned as BoardLead[],
  };
}
