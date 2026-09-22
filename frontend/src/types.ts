// API wire types (camelCase, matching the FastAPI responses).

export type Phase = "P" | "S";
export type PickStatus = "pending" | "accepted" | "rejected";

export interface Channel {
  id: number;
  station: string;
  channel: string;
  startTime: string;
  sampleRate: number;
  nSamples: number;
  samples: number[];
}

export interface Pick {
  id: number;
  datasetId: number;
  station: string;
  channel: string | null;
  phase: Phase;
  time: string;
  uncertainty: number;
  author: string;
  status: PickStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetSummary {
  id: number;
  name: string;
  source: string | null;
  startTime: string;
  endTime: string;
  nStations: number;
  nPicks: number;
  createdAt: string;
}

export interface DatasetDetail extends DatasetSummary {
  channels: Channel[];
  picks: Pick[];
}

export interface Conflict {
  station: string;
  phase: Phase;
  pickA: number;
  pickB: number;
  gap: number;
  basisOnly: boolean;
}

export interface ConsensusMember {
  pickId: number;
  author: string;
  status: PickStatus;
  inBasis: boolean;
  weight: number;
  distance: number;
}

export interface GroupConsensus {
  station: string;
  phase: Phase;
  time: string | null;
  uncertainty: number | null;
  uncertaintyInner: number | null;
  birgeFactor: number | null;
  nTotal: number;
  nBasis: number;
  consistent: boolean;
  members: ConsensusMember[];
}

export interface ConsensusReport {
  datasetId: number;
  groups: GroupConsensus[];
  conflicts: Conflict[];
}

export interface PickInput {
  station: string;
  channel: string | null;
  phase: Phase;
  time: string;
  uncertainty: number;
  author: string;
}

export interface SampleInfo {
  file: string;
  name: string;
  source: string | null;
  nChannels: number;
  nPicks: number;
}
