// Client-side mirror types for the ctx-hive API.
// These must stay in sync with the server-side definitions.

export type JobStatus = "pending" | "processing" | "done" | "failed";
export type Scope = "project" | "org" | "personal";
export type SearchSource = "inject" | "cli" | "api";

export interface JobView {
  filename: string;
  status: JobStatus;
  type: string;
  createdAt: string;
  sessionId?: string;
  cwd?: string;
  project?: string;
  reason?: string;
  error?: string;
  failedAt?: string;
  startedAt?: string;
  completedAt?: string;
  duration_ms?: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  jobs: {
    pending: number;
    processing: number;
    done: number;
    failed: number;
    total: number;
  };
  contexts: {
    total: number;
    byScope: Record<string, number>;
    byProject: Record<string, number>;
  };
  recentJobs: JobView[];
}

export interface IndexEntry {
  id: string;
  title: string;
  scope: Scope;
  tags: string[];
  project: string;
  created: string;
  updated: string;
  tokens: number;
  path: string;
}

export interface ContextEntry extends IndexEntry {
  body: string;
}

export interface HitBucket {
  date: string;
  count: number;
}

export interface RelevanceEval {
  evaluatedAt: string;
  sessionId: string;
  rating: -1 | 0 | 1 | 2;
  reason?: string;
}

export interface EntrySignals {
  searchHits: HitBucket[];
  evaluations: RelevanceEval[];
  score: number;
  scoreComputedAt: string;
}

export interface SignalsStore {
  entries: Record<string, EntrySignals>;
  updatedAt: string;
  version: 1;
}

export interface DiscoveredRepo {
  name: string;
  absPath: string;
  relPath: string;
  org: string;
  remoteUrl: string;
  tracked: boolean;
  trackedAt?: string;
  lastScannedAt?: string;
  contextCount: number;
  currentBranch: string;
  behindCount: number;
  modifiedCount: number;
  untrackedCount: number;
  defaultBranch: string;
  lastModifiedAt?: string;
  exists: boolean;
}

export interface SearchRecord {
  timestamp: string;
  source: SearchSource;
  query: string;
  project?: string;
  cwd?: string;
  sessionId?: string;
  resultCount: number;
  results: { id: string; title: string; score: number }[];
  durationMs: number;
}

export interface SearchStats {
  totalQueries: number;
  bySource: Record<string, number>;
  zeroResultQueries: number;
  avgResultCount: number;
  topServedEntries: { id: string; title: string; count: number }[];
  avgScoreOfServed: number;
}

export interface TrackedRepo {
  name: string;
  absPath: string;
  org: string;
  remoteUrl: string;
  trackedAt: string;
  lastScannedAt?: string;
}

export type WsEvent =
  | "metrics"
  | "job:started"
  | "job:completed"
  | "job:failed"
  | "job:queued"
  | "context:created"
  | "context:deleted"
  | "repo:tracked"
  | "repo:untracked"
  | "repo:scan-complete";
