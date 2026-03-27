// Client-side mirror types for the ctx-hive API.
// These must stay in sync with the server-side definitions.

export type JobStatus = "pending" | "processing" | "done" | "failed";
export type Scope = "project" | "org" | "personal";
export type SearchSource = "inject" | "cli" | "api";
export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type PipelineStatus = "pending" | "running" | "completed" | "failed";

// ── Pipeline types ───────────────────────────────────────────────────

export interface StageMetrics {
  itemsProcessed?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface StageExecution {
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  retryCount: number;
  error?: string;
  metrics: StageMetrics;
}

export interface PipelineExecution {
  id: string;
  pipelineName: string;
  status: PipelineStatus;
  jobFilename: string;
  project: string;
  startedAt: string;
  completedAt?: string;
  stages: StageExecution[];
  totalDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  entriesCreated?: number;
}

export interface PipelineStats {
  total: number;
  completed: number;
  failed: number;
  successRate: number;
  avgStageDurations: Record<string, number>;
  stageFailureRates: Record<string, number>;
}

// ── Job types ────────────────────────────────────────────────────────

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
  durationMs?: number;
  transcriptTokens?: number;
  entriesCreated?: number;
  inputTokens?: number;
  outputTokens?: number;
  pipeline?: PipelineExecution;
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

// ── Context types ────────────────────────────────────────────────────

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

// ── Repo types ───────────────────────────────────────────────────────

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

// ── Search types ─────────────────────────────────────────────────────

export interface SearchRecord {
  timestamp: string;
  source: SearchSource;
  query: string;
  project?: string;
  cwd?: string;
  sessionId?: string;
  resultCount: number;
  results: { id: string; title: string; score: number; tokens?: number; algorithm?: string }[];
  durationMs: number;
  ftsDurationMs?: number;
  vectorDurationMs?: number;
}

export interface SearchStats {
  totalQueries: number;
  bySource: Record<string, number>;
  zeroResultQueries: number;
  avgResultCount: number;
  topServedEntries: { id: string; title: string; count: number }[];
  avgScoreOfServed: number;
}

// ── Multi-algorithm search types ────────────────────────────────────

export type Algorithm = "fts5" | "vector";

export interface SearchResultEntry {
  id: string;
  title: string;
  scope: Scope;
  tags: string[];
  project: string;
  score: number;
  excerpt: string;
  tokens: number;
  path: string;
  created: string;
  updated: string;
  algorithms?: Algorithm[];
}

export interface AlgorithmResult {
  algorithm: Algorithm;
  results: SearchResultEntry[];
  durationMs: number;
}

export interface MultiSearchResponse {
  query: string;
  merged: SearchResultEntry[];
  algorithms: AlgorithmResult[];
  mergeStrategy: "fts5-only" | "rrf";
}

// ── Vector search settings types ────────────────────────────────────

export interface VectorSearchSettings {
  enabled: boolean;
  model: string;
  hasApiKey: boolean;
  embeddedCount: number;
  totalCount: number;
}

export interface BackfillStatus {
  inProgress: boolean;
  done: number;
  total: number;
  failed: number;
}

// ── Session types ────────────────────────────────────────────────────

export interface SessionServedEntry {
  id: string;
  title: string;
  maxScore: number;
  rating?: -1 | 0 | 1 | 2;
  reason?: string;
}

export interface SessionSummary {
  sessionId: string;
  project: string;
  firstSeen: string;
  lastSeen: string;
  injectionCount: number;
  servedEntries: SessionServedEntry[];
  evaluationComplete: boolean;
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
  | "repo:scan-complete"
  | "pipeline:started"
  | "pipeline:stage-changed"
  | "pipeline:completed"
  | "pipeline:failed"
  | "search:executed";
