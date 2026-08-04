export interface BoardLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  companyName: string | null;
  companyLocation: string | null;
  phone: string;
  dealValue: number | null;
  lastDisposition: string | null;
  stageId: string | null;
  stagePosition: number;
}

export interface BoardStage {
  id: string;
  name: string;
  color: string;
  position: number;
  leads: BoardLead[];
}

export interface BoardPipeline {
  id: string;
  name: string;
}

export interface BoardData {
  pipelines: BoardPipeline[];
  activePipelineId: string;
  stages: BoardStage[];
  /// Leads with no stage yet — rendered as the leftmost column so imported
  /// leads are never invisible.
  unassigned: BoardLead[];
}

/// Sentinel id for the Unassigned column, which is not a real stage row.
export const UNASSIGNED = '__unassigned__';

export function leadDisplayName(lead: BoardLead): string {
  const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
  return name || lead.companyName || lead.phone;
}
