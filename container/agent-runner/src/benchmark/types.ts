export type Mode = 'live_sec' | 'snapshot' | 'injected_failure';
export type Status = 'passed' | 'failed' | 'not_applicable' | 'needs_review';
export type Dimension =
  | 'task_completion'
  | 'tool_behavior'
  | 'numerical_correctness'
  | 'evidence_integrity'
  | 'artifact_delivery'
  | 'failure_handling'
  | 'judgment_boundary';
export interface Task {
  id: string;
  category: string;
  company: string;
  years: 1 | 3;
  mode: Mode;
  asOf: string;
  source: string;
  snapshot?: string;
  injection?: 'remove_cash_tag' | 'prior_revenue_eur' | 'sec_429';
  question: string;
  expected: string;
  failureConditions: string[];
  observe: string[];
  automatic: string[];
  manual: string[];
}
export interface ToolCall {
  order: number;
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: 'started' | 'succeeded' | 'failed';
  errorCode?: string;
  datasetId?: string;
  saved?: boolean;
}
export interface Trace {
  version: 1;
  task: Task;
  taskSetVersion: string;
  taskSetSha256: string;
  inputSha256: string;
  prompt: string;
  sessionId: string;
  entry: 'pi_runtime_adapter';
  modelAlias: string;
  status: 'executed' | 'not_executed';
  reason?: string;
  tools: ToolCall[];
  finalAnswer: string;
  stopReason?: string;
  elapsedMs: number | 'unavailable';
  modelRequests: number | 'unavailable';
  modelHttpStatuses?: number[];
  knownUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  usage: {
    input: number | 'unavailable';
    output: number | 'unavailable';
    cacheRead: number | 'unavailable';
    cacheWrite: number | 'unavailable';
    cost: 'unavailable';
  };
  artifacts: { path: string; sha256: string }[];
  datasetIds: string[];
}
export interface Check {
  status: Status;
  evidence: string[];
  boundary: string;
}
export interface Score {
  taskId: string;
  mode: Mode;
  execution: Trace['status'];
  overall: Status;
  dimensions: Record<Dimension, Check>;
  attribution: string[];
  review: string[];
}
