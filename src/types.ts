export const AGENTS = ['claude', 'codex'] as const;
export type ProviderKind = typeof AGENTS[number];
/** A conversation instance, independent of the provider running it. */
export type AgentId = string;
export interface AgentConfig { id: AgentId; provider: ProviderKind; }
export type Scope = 'discuss' | 'plan' | 'build';
export type Recipient = AgentId | 'both';
export type Delivery = 'queued' | 'immediate';
export interface PermissionSettings { mode: 'read-only' | 'project' | 'full'; additionalDirectories: string[] }
export interface ModelSettings { model: string | null; effort: string | null }
export interface ModelOption { id: string; name: string; efforts: string[]; defaultEffort?: string }
export interface ModelCatalog { models: ModelOption[]; defaultModel?: string; notice?: string }
export type Position = 'accept' | 'object' | 'evidence';
export interface TaskSpec { id: string; owner: AgentId; description: string; dependsOn: string[]; }
export interface Decision {
  id: string; kind: 'plan' | 'decision'; title: string; proposal: string;
  version: number; tasks: TaskSpec[];
  positions: Partial<Record<AgentId, { position: Position; reason: string; version: number }>>;
  rounds: number; status: 'open' | 'agreed' | 'waiting_user';
  userResolution?: string;
  needsRevision?: boolean;
}
export type CollaborationAction =
  | { type: 'propose'; id: string; kind: 'plan' | 'decision'; title: string; proposal: string; tasks: TaskSpec[] }
  | { type: 'position'; id: string; version: number; position: Position; reason: string }
  | { type: 'complete_task'; id: string; summary: string }
  | { type: 'finish'; summary: string }
  | { type: 'yield' };
export interface AgentReply { message: string; actions: CollaborationAction[]; }
export interface Message { id: string; at: string; from: AgentId | 'user' | 'system'; to: Recipient; text: string; delivery?: 'display-only'; }
export interface Activity { id: string; at: string; agent: AgentId; kind: 'tool' | 'status' | 'error'; text: string; }
export interface ContextCursor {
  nativeSessionId: string;
  version: string;
  configuration: string;
  /** A single hash is retained for compatibility with older delivery checkpoints. */
  state: string | { decisions: string; completedTasks: string; finished: string };
  contextDirectory?: string;
  messages: Record<string, string>;
  memory: Record<string, string>;
  inFlight: boolean;
}
export interface Session {
  id: string; createdAt: string; updatedAt: string; project: string; scope: Scope; brief: string;
  status: 'paused' | 'running' | 'waiting_user' | 'complete' | 'error';
  messages: Message[]; activities: Activity[]; decisions: Decision[];
  completedTasks: Record<string, string>; finished: Partial<Record<AgentId, string>>;
  providerSessions: Partial<Record<AgentId, string>>;
  contextCursors?: Partial<Record<AgentId, ContextCursor>>;
  /** Input revision at which an instance yielded without a message or action. */
  yieldedInputs?: Partial<Record<AgentId, string>>;
  models?: Partial<Record<AgentId, string | null>>;
  efforts?: Partial<Record<AgentId, string | null>>;
  /** Missing only in legacy two-provider sessions. */
  agents?: AgentConfig[];
  providerModels?: Partial<Record<ProviderKind, string>>;
  providerEfforts?: Partial<Record<ProviderKind, string | null>>;
  permissions?: PermissionSettings;
  /** Idle composer, distinguished from an explicit user pause. */
  awaitingInput?: boolean;
  /** Chat replies only to addressed user messages; collaboration is explicitly started. */
  interaction?: 'chat' | 'collaborate';
  pendingRecipients?: AgentId[];
  turns: number; maxTurns: number; maxMinutes: number; elapsedMs: number;
  demo: boolean; error?: string;
  integration?: { status: 'pending' | 'review' | 'conflicts' | 'accepted'; path?: string; notes?: string };
}
export interface ProviderTurn {
  agent: AgentId; prompt: string; cwd: string; writable: boolean;
  permissions?: PermissionSettings;
  sessionId?: string; model?: string | null; effort?: string | null; title?: string; signal: AbortSignal;
}
export type ProviderEvent =
  | { type: 'text'; text: string }
  | { type: 'activity'; text: string }
  | { type: 'session'; sessionId: string }
  | { type: 'tool_boundary' }
  | { type: 'reply'; reply: AgentReply };
export interface AgentProvider {
  readonly id: AgentId;
  run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply>;
  listModels?(cwd: string): Promise<ModelCatalog>;
  dispose(): Promise<void>;
}
export interface WorkspaceAccess { cwd: string; writable: boolean; }
export interface WorkspaceManager {
  prepare(session: Session, agent: AgentId): Promise<WorkspaceAccess>;
}
export interface ViewState {
  session: Session;
  streams: Record<AgentId, string>;
  busy: Record<AgentId, boolean>;
  recipient: Recipient;
  delivery: Delivery;
}
export interface UIController {
  getView(): ViewState;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  pause(): Promise<void>;
  send(text: string, to?: Recipient, delivery?: Delivery): Promise<void>;
  collaborate?(text: string): Promise<void>;
  setRecipient(to: Recipient): void;
  setDelivery(mode: Delivery): void;
  addAgent?(provider: ProviderKind): Promise<void>;
  setInitialAgent?(provider: ProviderKind): Promise<void>;
  getModelOptions?(agent: AgentId): Promise<ModelCatalog>;
  setModelSettings?(agent: AgentId, settings: ModelSettings): Promise<void>;
  setPermissions?(settings: PermissionSettings): Promise<void>;
  resolve(id: string, resolution: string): Promise<void>;
  acceptIntegration?(notes: string): Promise<void>;
  detach?(): Promise<void>;
  close(): Promise<void>;
}
