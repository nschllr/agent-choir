import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { sessionPermissions, validPermissions } from './permissions.js';
import { integrationPrompt } from './integration.js';
import { nativeSessionTitle } from './session-label.js';
import { claudeEfforts, codexEfforts, fallbackCatalog, validModelSettings } from './model-settings.js';
import type { ModelCatalog, ModelSettings, PermissionSettings, IntegrationCandidate, WorkspaceAccess } from './types.js';
import { applyReply, canImplement, resolveDecision } from './engine.js';
import { buildContextDelivery, contextHash, contextMessages, hasPendingContext, messageHash } from './context-delivery.js';
import type { ContextMemory } from './context-memory.js';
import type { ContextCursor } from './types.js';
import { type AgentConfig, type ProviderKind, type Activity, type AgentId, type AgentProvider, type AgentReply, type Delivery, type Recipient, type Session, type UIController, type ViewState, type WorkspaceManager } from './types.js';

import { agentIds, isCollaborating, isProvider, sessionAgents } from './agents.js';

interface TurnResult { reply: AgentReply; ticket: number; inputRevision: number; context: ContextCursor; inputHash: string; }
type PendingTurn = { agent: AgentId; result?: TurnResult } | { agent: AgentId; error: unknown };

interface Persistence { save(session: Session): void; }
interface Workspaces extends WorkspaceManager {
  finalize?(session: Session, agent: AgentId): Promise<string | null>;
  merge?(session: Session): Promise<{ path: string; conflicts: boolean }>;
  prepareIntegration?(session: Session, agent: AgentId): Promise<WorkspaceAccess>;
  finishIntegration?(session: Session): Promise<IntegrationCandidate>;
  verifyIntegration?(session: Session, revision: string): Promise<boolean>;
}
export class DuetController implements UIController {
  private catalogs = new Map<AgentId, Promise<ModelCatalog>>();
  private state: ViewState;
  private listeners = new Set<() => void>();
  private running?: Promise<void>;
  private wakeDirect?: () => void;
  private aborts = new Map<AgentId, AbortController>();
  private tickets: Record<AgentId, number> = {};
  private rosterChanging = false;
  private inputRevision = 0;
  private recipientRevisions: Record<AgentId, number> = {};
  private queued = new Set<AgentId>();
  private next: AgentId;
  private timer?: ReturnType<typeof setTimeout>;
  private tickAt = 0;
  private closed = false;
  constructor(session: Session, private providers: Record<AgentId, AgentProvider>, private store: Persistence, private workspaces: Workspaces, private providerFactory?: (config: AgentConfig) => AgentProvider, private memory?: Pick<ContextMemory, 'prepare'>) {
    const ids = agentIds(session);
    if (!session.brief.trim() && session.awaitingInput === undefined) session.awaitingInput = true;
    this.state = { session, streams: Object.fromEntries(ids.map(id => [id, ''])), busy: Object.fromEntries(ids.map(id => [id, false])), recipient: isCollaborating(session) && ids.length > 1 ? 'both' : ids[0]!, delivery: 'queued' };
    for (const id of ids) this.tickets[id] = 0;
    const last = [...session.messages].reverse().find(m => ids.includes(m.from));
    this.next = last ? ids[(ids.indexOf(last.from) + 1) % ids.length]! : ids[0]!;
    if (!isCollaborating(session) && session.pendingRecipients === undefined) {
      const latest = [...session.messages].reverse().find(m => m.from === 'user');
      const index = latest ? session.messages.indexOf(latest) : -1;
      session.pendingRecipients = latest ? ids.filter(id => (latest.to === 'both' || latest.to === id) && !session.messages.slice(index + 1).some(m => m.from === id)) : [];
      if (!session.pendingRecipients.length && !['running', 'waiting_user', 'error'].includes(session.status)) session.awaitingInput = true;
    }
    this.save();
  }
  private ids(): AgentId[] { return agentIds(this.state.session); }
  private automaticIntegration(): boolean { return !this.state.session.demo && this.ids().length === 2 && Boolean(this.workspaces.prepareIntegration && this.workspaces.finishIntegration && this.workspaces.verifyIntegration); }
  async getModelOptions(agent: AgentId): Promise<ModelCatalog> {
    const config = sessionAgents(this.state.session).find(item => item.id === agent);
    if (this.closed || !config) throw new Error('Unknown or closed agent');
    if (this.state.session.demo) return { models: [{ id: `demo-${config.provider}`, name: 'Offline demo model', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }], defaultModel: `demo-${config.provider}`, notice: 'Offline demo; no native model queries or calls.' };
    if (!this.catalogs.has(agent)) {
      const query = this.providers[agent].listModels?.(this.state.session.project) ?? Promise.resolve(fallbackCatalog(config.provider));
      this.catalogs.set(agent, query.catch(() => {
        this.catalogs.delete(agent);
        return { ...fallbackCatalog(config.provider), notice: 'Native model discovery failed. Enter a model ID or keep defaults; check the installed CLI and login.' };
      }));
    }
    return this.catalogs.get(agent)!;
  }
  async setModelSettings(agent: AgentId, settings: ModelSettings): Promise<void> {
    if (!validModelSettings(settings)) throw new Error('Invalid model or reasoning effort settings');
    const provider = this.providers[agent];
    const catalog = await this.getModelOptions(agent);
    if (this.closed || this.rosterChanging || this.providers[agent] !== provider) throw new Error('Agent changed while choosing model settings');
    const config = sessionAgents(this.state.session).find(item => item.id === agent)!;
    const model = catalog.models.find(item => item.id === (settings.model ?? catalog.defaultModel));
    const levels = model?.efforts ?? (config.provider === 'claude' ? claudeEfforts : codexEfforts);
    if (settings.effort !== null && !levels.includes(settings.effort)) throw new Error('That reasoning effort is not supported by the selected model');
    this.state.session.models ??= {}; this.state.session.efforts ??= {};
    this.state.session.models[agent] = settings.model;
    this.state.session.efforts[agent] = settings.effort;
    // Changes affect future snapshots, without interrupting a running native turn or waking a peer.
    this.save();
  }
  private validateRecipient(to: Recipient): void { if (to !== 'both' && !this.ids().includes(to)) throw new Error('Unknown message recipient'); }
  async setPermissions(settings: PermissionSettings): Promise<void> {
    if (!validPermissions(settings)) throw new Error('Invalid permission settings');
    if (this.state.session.demo && settings.mode !== 'read-only') throw new Error('Offline demo sessions remain read-only');
    if (this.closed || this.rosterChanging) throw new Error('Session cannot change permissions now');
    this.rosterChanging = true;
    const idle = this.state.session.awaitingInput === true;
    try {
      const directories = await Promise.all(settings.additionalDirectories.map(async path => {
        const absolute = await realpath(resolve(this.state.session.project, path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path));
        if (!(await stat(absolute)).isDirectory()) throw new Error(`Not a directory: ${path}`);
        return absolute;
      }));
      // Terminate old native turns before widening or narrowing access.
      await this.pause();
      if (this.closed) throw new Error('Session is closed');
      const updated = structuredClone(this.state.session);
      updated.permissions = { mode: settings.mode, additionalDirectories: [...new Set(directories)] };
      updated.scope = settings.mode === 'read-only' ? 'discuss' : 'build';
      updated.awaitingInput = idle;
      updated.updatedAt = new Date().toISOString();
      this.store.save(updated); this.state.session = updated; this.notify();
    } finally { this.rosterChanging = false; }
  }
  private successor(agent: AgentId): AgentId { const ids = this.ids(); return ids[(ids.indexOf(agent) + 1) % ids.length]!; }
  async setInitialAgent(provider: ProviderKind): Promise<void> {
    if (!isProvider(provider)) throw new Error('Unknown provider');
    if (this.closed || this.rosterChanging || this.running || this.ids().length !== 1 || this.state.session.turns || this.state.session.messages.some(m => m.from !== 'system') || this.state.session.brief.trim()) throw new Error('The initial agent can only be changed before the conversation starts');
    if (!this.providerFactory) throw new Error('Provider selection is unavailable');
    this.rosterChanging = true;
    try {
      const id = this.ids()[0]!, config = { id, provider }, replacement = this.providerFactory(config);
      await this.providers[id]!.dispose(); this.providers[id] = replacement;
      this.catalogs.delete(id);
      this.state.session.agents = [config]; delete this.state.session.providerSessions[id];
      if (this.state.session.contextCursors) delete this.state.session.contextCursors[id];
      if (this.state.session.yieldedInputs) delete this.state.session.yieldedInputs[id];
      this.state.session.models ??= {}; delete this.state.session.models[id];
      this.state.session.efforts ??= {}; delete this.state.session.efforts[id];
      if (this.state.session.providerEfforts?.[provider] !== undefined) this.state.session.efforts[id] = this.state.session.providerEfforts[provider];
      if (this.state.session.providerModels?.[provider]) this.state.session.models[id] = this.state.session.providerModels[provider];
      this.save();
    } finally { this.rosterChanging = false; }
  }
  async addAgent(provider: ProviderKind): Promise<void> {
    if (!isProvider(provider)) throw new Error('Unknown provider');
    if (this.closed || this.rosterChanging) throw new Error('Session cannot change agents now');
    if (this.ids().length >= 2) throw new Error('This session already has two agents');
    if (this.state.session.integration && this.state.session.integration.status !== 'accepted') throw new Error('Validate the pending integration candidate before adding an agent');
    if (!this.providerFactory) throw new Error('Provider selection is unavailable');
    this.rosterChanging = true;
    const wasAwaitingInput = this.state.session.awaitingInput === true || this.state.session.status === 'running';
    try {
      await this.pause();
      const id = this.ids().includes('agent-2') ? 'agent-1' : 'agent-2', config = { id, provider };
      const instance = this.providerFactory(config);
      // A peer joining a completed build must review the plan again. The next
      // completion prepares a fresh validation checkpoint for that roster.
      if (this.state.session.integration?.status === 'accepted') delete this.state.session.integration;
      this.providers[id] = instance; this.tickets[id] = 0;
      this.state.session.agents = [...sessionAgents(this.state.session), config];
      this.state.streams[id] = ''; this.state.busy[id] = false;
      this.state.session.models ??= {};
      if (this.state.session.providerEfforts?.[provider] !== undefined) {
        this.state.session.efforts ??= {}; this.state.session.efforts[id] = this.state.session.providerEfforts[provider];
      }
      if (this.state.session.providerModels?.[provider]) this.state.session.models[id] = this.state.session.providerModels[provider];
      this.state.session.finished = {};
      for (const decision of this.state.session.decisions) {
        if (decision.status === 'waiting_user' || (decision.userResolution && decision.kind !== 'plan')) continue;
        if (decision.status === 'agreed') decision.rounds = 0;
        decision.status = 'open'; decision.positions = {};
      }
      if (this.state.session.status === 'complete' || this.state.session.status === 'waiting_user') this.state.session.status = 'paused';
      this.state.recipient = id; this.next = id; this.state.session.awaitingInput = wasAwaitingInput && !this.state.session.decisions.some(decision => decision.status === 'waiting_user');
      this.save();
    } finally { this.rosterChanging = false; }

  }
  getView(): ViewState { return structuredClone(this.state); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private save(): void {
    if (this.tickAt) { const now = Date.now(); this.state.session.elapsedMs += now - this.tickAt; this.tickAt = now; }
    this.state.session.updatedAt = new Date().toISOString(); this.store.save(this.state.session); this.notify();
  }
  private activity(agent: AgentId, text: string, kind: Activity['kind'] = 'status'): void {
    this.state.session.activities.push({ id: randomUUID(), at: new Date().toISOString(), agent, kind, text });
    this.state.session.activities = this.state.session.activities.slice(-500); this.save();
  }
  private note(text: string, displayOnly = false): void { this.state.session.messages.push({ id: randomUUID(), at: new Date().toISOString(), from: 'system', to: 'both', text, ...(displayOnly ? { delivery: 'display-only' as const } : {}) }); this.save(); }
  async start(): Promise<void> {
    if (this.closed) throw new Error('Session is closed');
    if (this.running || this.rosterChanging || this.state.session.status === 'complete' || !this.state.session.brief.trim()) return;
    this.state.session.awaitingInput = false;
    if (this.state.session.integration?.status === 'waiting_user') throw new Error('Resolve integration with /resolve integration <your decision> before resuming');
    if (this.state.session.integration && this.state.session.integration.status !== 'accepted' && !this.automaticIntegration()) {
      if (['pending', 'conflicts'].includes(this.state.session.integration.status)) {
        this.running = this.integrate().catch(error => {
          this.state.session.status = 'error'; this.state.session.error = error instanceof Error ? error.message : String(error); this.save();
        }).finally(() => { this.running = undefined; this.notify(); });
        await this.running; return;
      }
      throw new Error('Integration is awaiting validation. Inspect the candidate and use /accept <validation evidence>.');
    }
    if (this.state.session.decisions.some(d => d.status === 'waiting_user')) throw new Error('Resolve the pending decision first with /resolve');
    const s = this.state.session;
    if (!isCollaborating(s) && !s.pendingRecipients?.length && (!s.integration || s.integration.status === 'accepted')) { s.awaitingInput = true; this.save(); return; }
    // An explicit resume renews an exhausted allowance; never renew automatically.
    if (s.turns >= s.maxTurns) s.maxTurns += 30;
    if (s.elapsedMs >= s.maxMinutes * 60_000) s.maxMinutes += 30;
    s.status = 'running'; delete s.error; this.tickAt = Date.now(); this.save();
    this.timer = setTimeout(() => { this.stop('Session time limit reached. Resume explicitly to add 30 minutes.'); }, Math.max(1, s.maxMinutes * 60_000 - s.elapsedMs));
    this.running = this.loop().catch(error => {
      this.state.session.status = 'error'; this.state.session.error = String(error instanceof Error ? error.message : error); this.stop(); this.save();
    }).finally(() => {
      if (this.timer) clearTimeout(this.timer); this.save(); this.tickAt = 0; this.running = undefined; this.notify();
      // A UI subscriber can submit just as the previous turn becomes idle.
      if (!this.closed && !isCollaborating(this.state.session) && this.state.session.awaitingInput && this.state.session.pendingRecipients?.length) void this.start().catch(error => {
        this.state.session.status = 'error'; this.state.session.error = error instanceof Error ? error.message : String(error); this.save();
      });
    });
  }
  /** Used by headless execution and tests without changing interactive start semantics. */
  async wait(): Promise<void> { await this.running; }
  private stop(reason?: string): void {
    this.state.session.awaitingInput = false;
    if (this.state.session.status === 'running') this.state.session.status = 'paused';
    for (const agent of this.ids()) { this.tickets[agent]++; this.aborts.get(agent)?.abort(); }
    this.wakeDirect?.();
    if (reason) this.note(reason); else this.save();
  }
  async pause(): Promise<void> { this.stop(); await this.running; }
  setRecipient(to: Recipient): void { this.validateRecipient(to); this.state.recipient = to; this.notify(); }
  setDelivery(mode: Delivery): void { this.state.delivery = mode; this.notify(); }
  async send(text: string, to = this.state.recipient, delivery = this.state.delivery): Promise<void> {
    if (!text.trim()) return;
    if (this.closed || this.rosterChanging) throw new Error('Session cannot receive messages now');
    if (this.state.session.integration && this.state.session.integration.status !== 'accepted' && this.automaticIntegration()) {
      const resume = this.state.session.status === 'running';
      await this.pause();
      const s = this.state.session, i = s.integration!;
      s.messages.push({ id: randomUUID(), at: new Date().toISOString(), from: 'user', to: 'both', text: text.trim() });
      this.inputRevision++;
      if (i.owner && i.status !== 'waiting_user') { i.status = 'resolving'; delete i.revision; }
      this.save();
      if (resume) await this.start();
      return;
    }
    const autoStart = this.state.session.awaitingInput === true || this.state.session.status === 'complete';
    this.validateRecipient(to);
    if (this.closed || this.rosterChanging) throw new Error('Session cannot receive messages now');
    const wasCollaborating = isCollaborating(this.state.session);
    const addressed = this.ids().filter(id => to === 'both' || to === id);
    this.state.session.interaction = 'chat';
    this.state.session.pendingRecipients ??= [];
    if (!this.state.session.brief.trim()) this.state.session.brief = text.trim();
    this.inputRevision++;
    this.state.session.messages.push({ id: randomUUID(), at: new Date().toISOString(), from: 'user', to, text: text.trim() });
    this.state.session.finished = {};
    if (this.state.session.status === 'complete') this.state.session.status = 'paused';
    for (const agent of this.ids()) {
      if (!addressed.includes(agent)) {
        if (wasCollaborating && this.aborts.has(agent)) { this.tickets[agent]++; this.aborts.get(agent)?.abort(); }
        continue;
      }
      this.recipientRevisions[agent] = (this.recipientRevisions[agent] ?? 0) + 1;
      if (!this.state.session.pendingRecipients.includes(agent)) this.state.session.pendingRecipients.push(agent);
      if (delivery === 'immediate') { this.tickets[agent]++; this.aborts.get(agent)?.abort(); }
      else if (this.aborts.has(agent)) this.queued.add(agent);
    }
    if (to !== 'both') this.next = to;
    this.save();
    this.wakeDirect?.();
    if (autoStart && !this.running) await this.start();
  }
  async collaborate(text: string): Promise<void> {
    if (!text.trim()) throw new Error('Include a task for collaboration');
    if (this.state.session.integration && this.state.session.integration.status !== 'accepted' && this.automaticIntegration()) return this.send(text, 'both');
    if (this.ids().length !== 2) throw new Error('Add a second agent before starting collaboration');
    if (this.closed || this.rosterChanging) throw new Error('Session cannot receive messages now');
    await this.pause();
    const s = this.state.session;
    if (s.integration && s.integration.status !== 'accepted') throw new Error('Validate the pending integration candidate first');
    if (s.decisions.some(d => d.status === 'waiting_user')) throw new Error('Resolve the pending decision first with /resolve');
    for (const message of s.messages) { message.to = 'both'; delete message.delivery; }
    s.interaction = 'collaborate'; s.pendingRecipients = []; s.finished = {};
    s.brief = text.trim(); s.status = 'paused'; s.awaitingInput = false;
    s.messages.push({ id: randomUUID(), at: new Date().toISOString(), from: 'user', to: 'both', text: text.trim() });
    this.inputRevision++; this.save();
    await this.start();
  }

  async resolve(id: string, resolution: string): Promise<void> {
    if (id === 'integration' && this.state.session.integration?.status === 'waiting_user') {
      if (!resolution.trim()) throw new Error('Include your integration decision');
      await this.pause();
      const i = this.state.session.integration!;
      i.status = 'resolving'; i.userResolution = resolution.trim(); i.rounds = 0; delete i.revision;
      this.state.session.status = 'paused';
      this.note(`User resolved integration: ${resolution.trim()}. Resume to implement and review that decision.`);
      return;
    }
    await this.pause(); this.state.session = resolveDecision(this.state.session, id, resolution); this.save();
    await this.memory?.prepare(this.state.session);
  }
  async acceptIntegration(notes: string): Promise<void> {
    if (this.running) throw new Error('Pause before accepting integration');
    const integration = this.state.session.integration;
    if (!integration || integration.status !== 'review') throw new Error('No conflict-free integration candidate to accept');
    if (!notes.trim()) throw new Error('Include the combined validation you performed');
    integration.status = 'accepted'; integration.notes = notes.trim();
    this.state.session.status = !isCollaborating(this.state.session) && this.state.session.pendingRecipients?.length ? 'paused' : 'complete'; this.note(`User accepted integrated candidate. Validation: ${notes.trim()}`);
    await this.memory?.prepare(this.state.session);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    await this.pause(); await Promise.all(this.ids().map(a => this.providers[a].dispose())); this.closed = true;
  }
  private inputHash(s: Session, agent: AgentId): string {
    return contextHash({ agents: sessionAgents(s), interaction: s.interaction, scope: s.scope,
      decisions: s.decisions, completedTasks: s.completedTasks, finished: s.finished,
      messages: contextMessages(s, agent).filter(m => m.from !== agent).map(m => [m.id, messageHash(m)]) });
  }
  private selectAgents(): AgentId[] {
    const s = this.state.session;
    const tasks = canImplement(s) ? s.decisions.find(d => d.kind === 'plan')?.tasks ?? [] : [];
    const readyTask = (a: AgentId) => tasks.some(t => t.owner === a && !Object.hasOwn(s.completedTasks, t.id) && t.dependsOn.every(id => Object.hasOwn(s.completedTasks, id)));
    const eligible = this.ids().filter(a => s.yieldedInputs?.[a] !== this.inputHash(s, a) && (hasPendingContext(s, a) || readyTask(a)));
    const initial = eligible.filter(a => !s.finished[a] && !s.messages.some(m => m.from === a));
    if (initial.length) {
      const latestUser = [...s.messages].reverse().find(message => message.from === 'user');
      if (!s.messages.some(message => this.ids().includes(message.from)) && latestUser?.to !== 'both') {
        const addressed = initial.filter(id => id === latestUser?.to);
        if (addressed.length) return addressed;
      }
      return initial;
    }
    if (canImplement(s)) {
      const ready = eligible.filter(readyTask);
      if (ready.length) return sessionPermissions(s).mode === 'full' || sessionPermissions(s).additionalDirectories.length ? ready.slice(0, 1) : ready;
    }
    const next = eligible.includes(this.next) && !s.finished[this.next] ? this.next : eligible.find(a => !s.finished[a]);
    return next ? [next] : [];
  }
  private async loop(): Promise<void> {
    while (this.state.session.status === 'running') {
      const s = this.state.session;
      if (s.integration && s.integration.status !== 'accepted' && this.automaticIntegration()) { await this.integrationLoop(); return; }
      if (!isCollaborating(s)) {
        await this.directLoop();
        if (this.state.session.integration?.status === 'pending' && (!this.automaticIntegration() || this.state.session.status === 'running')) await this.integrate();
        return;
      }
      if (s.turns >= s.maxTurns) { this.stop('Turn limit reached. Resume explicitly to add 30 turns.'); break; }
      const selected = this.selectAgents().slice(0, s.maxTurns - s.turns);
      if (!selected.length) {
        s.status = 'paused'; s.awaitingInput = true;
        const notice = 'No further agent input is pending. Waiting for your next message; unfinished work remains pending.';
        if (s.messages.at(-1)?.text !== notice) this.note(notice, true); else this.save();
        break;
      }
      const results = await Promise.all(selected.map(agent => this.runAgent(agent)));
      for (let i = 0; i < results.length; i++) await this.acceptReply(selected[i], results[i]);
      if (this.state.session.integration?.status === 'pending' && (!this.automaticIntegration() || this.state.session.status === 'running')) await this.integrate();
    }
  }
  /** Direct recipients run independently; state transitions are applied one at a time. */
  private async directLoop(): Promise<void> {
    const active = new Map<AgentId, Promise<PendingTurn>>();
    try {
      while (this.state.session.status === 'running') {
        // Register before launching turns so input arriving during startup cannot be lost.
        const input = new Promise<undefined>(resolve => { this.wakeDirect = () => resolve(undefined); });
        const s = this.state.session;
        if (!active.size && !s.pendingRecipients?.length) {
          s.status = 'paused'; s.awaitingInput = true; this.save(); break;
        }
        if (!active.size && s.turns >= s.maxTurns) {
          this.stop('Turn limit reached. Resume explicitly to add 30 turns.'); break;
        }
        // Reserve a turn for each in-flight request, including results not yet applied.
        const available = Math.min(Math.max(0, s.maxTurns - s.turns - active.size), s.scope === 'build' && !s.demo ? Math.max(0, 1 - active.size) : Infinity);
        const ready = (s.pendingRecipients ?? []).filter(agent => !active.has(agent)).slice(0, available);
        for (const agent of ready) {
          active.set(agent, this.runAgent(agent).then(
            result => ({ agent, result }),
            error => ({ agent, error }),
          ));
        }
        const completed = await Promise.race([...active.values(), input]);
        if (!completed) continue;
        active.delete(completed.agent);
        if ('error' in completed) throw completed.error;
        await this.acceptReply(completed.agent, completed.result);
      }
      // A checkpoint or pause interrupts unfinished recipients. Their queue entries
      // survive for explicit resume; no provider output may arrive during integration.
      for (const agent of active.keys()) { this.tickets[agent]++; this.aborts.get(agent)?.abort(); }
      await Promise.all(active.values());
    } finally { this.wakeDirect = undefined; }
  }
  private async acceptReply(agent: AgentId, result: TurnResult | undefined): Promise<void> {
    if (!result || result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') return;
    try {
      const chat = !isCollaborating(this.state.session);
      // Native resumed conversations may still emit an old finish action.
      const reply = { ...result.reply, message: result.reply.message.trim() ? result.reply.message : '',
        actions: chat ? result.reply.actions.filter(action => action.type === 'yield') : result.reply.actions };
      const updated = applyReply(this.state.session, agent, reply);
      if (reply.actions.some(a => a.type === 'complete_task')) await this.workspaces.finalize?.(updated, agent);
      if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') return;
      // Finalization may have awaited Git while the user added instructions.
      this.state.session = applyReply(this.state.session, agent, reply);
      const ownMessage = this.state.session.messages.at(-1);
      if (reply.message && ownMessage?.from === agent) result.context.messages[ownMessage.id] = messageHash(ownMessage);
      this.acknowledgeContext(agent, result.context);
      const yielded = reply.actions.some(a => a.type === 'yield');
      if (yielded || (!reply.message && !reply.actions.length)) {
        this.state.session.yieldedInputs ??= {};
        this.state.session.yieldedInputs[agent] = result.inputHash;
        this.activity(agent, yielded ? 'Yielded; no peer reply requested. Waiting for new input.' : 'No message or actions; waiting for new input.');
      } else if (this.state.session.yieldedInputs) delete this.state.session.yieldedInputs[agent];
      const plan = this.state.session.decisions.find(decision => decision.kind === 'plan');
      if (!chat && this.state.session.status === 'complete' && this.state.session.scope === 'build' && plan?.tasks.length && !this.state.session.demo) {
        this.state.session.integration = { status: 'pending' }; this.state.session.status = this.automaticIntegration() ? 'running' : 'paused';
      }
      this.state.streams[agent] = ''; this.next = this.successor(agent);
      if (chat) {
        if (result.inputRevision === (this.recipientRevisions[agent] ?? 0)) this.state.session.pendingRecipients = this.state.session.pendingRecipients?.filter(id => id !== agent);
        this.state.session.finished = {};
        if (['running', 'complete'].includes(this.state.session.status)) this.state.session.status = 'running';
      }
      this.save();
    } catch (error) {
      if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') return;
      this.acknowledgeContext(agent, result.context);
      this.state.session.turns++;
      this.note(`Rejected ${agent}'s response: ${error instanceof Error ? error.message : error}.${isCollaborating(this.state.session) ? ' Correct the structured actions on your next turn.' : ' Send a follow-up to try again.'}`);
      this.next = agent;
      if (!isCollaborating(this.state.session)) {
        if (result.inputRevision === (this.recipientRevisions[agent] ?? 0)) this.state.session.pendingRecipients = this.state.session.pendingRecipients?.filter(id => id !== agent);
      }
      this.save();
    }
    await this.memory?.prepare(this.state.session);
  }
  private acknowledgeContext(agent: AgentId, context: ContextCursor): void {
    this.state.session.contextCursors ??= {};
    this.state.session.contextCursors[agent] = { ...context, nativeSessionId: this.state.session.providerSessions[agent] ?? '', inFlight: false };
  }
  private async integrate(): Promise<void> {
    const tasks = this.state.session.decisions.find(d => d.kind === 'plan')?.tasks ?? [];
    const integrated = tasks.length ? await this.workspaces.merge?.(this.state.session) : { path: this.state.session.project, conflicts: false };
    if (!integrated) throw new Error('Build integration is unavailable');
    if (this.automaticIntegration()) {
      const previous = this.state.session.integration;
      this.state.session.integration = { ...previous, path: integrated.path, status: 'resolving', owner: previous?.owner ?? this.ids()[0], reviewer: previous?.reviewer ?? this.ids()[1], rounds: previous?.rounds ?? 0 };
      this.note(`Integration workspace: ${integrated.path}. ${this.state.session.integration.owner} will resolve conflicts and validate; ${this.state.session.integration.reviewer} will review the candidate. Original branch unchanged.`);
      return;
    }
    this.state.session.integration = { path: integrated.path, status: integrated.conflicts ? 'conflicts' : 'review' };
    this.state.session.status = 'paused';
    this.note(integrated.conflicts ? `Integration conflict. Work preserved at ${integrated.path}; original branch unchanged. Resolve the candidate manually before accepting it.` : `Integration checkpoint: ${integrated.path}. Inspect the combined diff, run validation, then /accept <validation evidence>. Original branch unchanged.`);
    await this.memory?.prepare(this.state.session);
  }
  private async integrationLoop(): Promise<void> {
    if (!this.state.session.integration?.owner) await this.integrate();
    while (this.state.session.status === 'running') {
      const s = this.state.session, i = s.integration!;
      if (i.status === 'accepted' || i.status === 'waiting_user') return;
      if (s.turns >= s.maxTurns) { this.stop('Integration turn limit reached. Resume explicitly to continue.'); return; }
      if (i.status === 'resolving' && s.scope !== 'build') { this.stop('Integration requires project edits. Change /permissions, then /resume.'); return; }
      const agent = i.status === 'resolving' ? i.owner! : i.reviewer!;
      const expected = JSON.stringify(i);
      const result = await this.runAgent(agent, true);
      if (!result || result.ticket !== this.tickets[agent] || this.state.session.status !== 'running' || JSON.stringify(this.state.session.integration) !== expected) continue;
      this.state.session.turns++;
      this.acknowledgeContext(agent, result.context);
      try {
        const report = result.reply.actions[0];
        if (result.reply.actions.length !== 1 || report?.type !== 'integration_report') throw new Error('Return exactly one integration_report with evidence');
        const allowed = i.status === 'resolving' ? ['ready', 'consult', 'blocked'] : i.status === 'consulting' ? ['advice', 'blocked'] : ['accept', 'changes_requested', 'blocked'];
        if (!allowed.includes(report.outcome)) throw new Error('That integration outcome is not valid for your current role');
        if (i.status === 'peer_review' && report.revision !== i.revision) throw new Error('Review must name the exact candidate revision');
        if (report.outcome === 'ready') {
          const candidate = await this.workspaces.finishIntegration!(this.state.session);
          if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') continue;
          i.path = candidate.path;
          if (candidate.conflicts || candidate.needsValidation) { i.notes = candidate.conflicts ? 'Further merge conflicts remain. Resolve them and rerun combined validation.' : 'Further finalized commits were merged after your checks. Rerun validation on the combined candidate.'; delete i.revision; }
          else {
            if (!candidate.revision || !await this.workspaces.verifyIntegration!(this.state.session, candidate.revision)) throw new Error('Candidate is not clean or does not contain all completed task commits');
            if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') continue;
            i.status = 'peer_review'; i.revision = candidate.revision; i.validation = report.summary; i.notes = report.summary;
          }
        } else if (report.outcome === 'accept') {
          const unchanged = await this.workspaces.verifyIntegration!(this.state.session, i.revision!);
          if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') continue;
          if (!unchanged) {
            i.status = 'resolving'; delete i.revision; i.notes = 'Candidate changed during review. Revalidate the current tree and request a fresh review.';
          } else {
            if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') continue;
            i.status = 'accepted'; i.notes = report.summary;
            this.state.session.status = !isCollaborating(this.state.session) && this.state.session.pendingRecipients?.length ? 'paused' : 'complete';
          }
        } else if (report.outcome === 'blocked') {
          i.status = 'waiting_user'; i.notes = report.summary; this.state.session.status = 'waiting_user';
        } else if (report.outcome === 'advice') { i.status = 'resolving'; i.notes = report.summary; }
        else {
          i.rounds = (i.rounds ?? 0) + (report.outcome === 'changes_requested' ? 1 : 0); i.notes = report.summary; delete i.revision;
          i.status = i.rounds >= 3 ? 'waiting_user' : report.outcome === 'consult' ? 'consulting' : 'resolving';
          if (i.status === 'waiting_user') this.state.session.status = 'waiting_user';
        }
        const message = { id: randomUUID(), at: new Date().toISOString(), from: agent, to: 'both', text: result.reply.message.trim() || report.summary };
        this.state.session.messages.push(message);
        this.state.session.contextCursors![agent]!.messages[message.id] = messageHash(message);
        this.state.streams[agent] = ''; this.save();
      } catch (error) {
        if (result.ticket !== this.tickets[agent] || this.state.session.status !== 'running') continue;
        this.note(`Integration response needs correction: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  private async runAgent(agent: AgentId, integrating = false): Promise<TurnResult | undefined> {
    const inputRevision = isCollaborating(this.state.session) ? this.inputRevision : this.recipientRevisions[agent] ?? 0;
    const ticket = ++this.tickets[agent], abort = new AbortController(); this.aborts.set(agent, abort); this.queued.delete(agent);
    this.state.busy[agent] = true; this.state.streams[agent] = ''; this.notify();
    try {
      const memory = await this.memory?.prepare(this.state.session);
      if (abort.signal.aborted) return;
      const snapshot = structuredClone(this.state.session);
      const workspace = snapshot.demo ? { cwd: snapshot.project, writable: false } : integrating ? await this.workspaces.prepareIntegration!(snapshot, agent) : await this.workspaces.prepare(snapshot, agent);
      if (abort.signal.aborted) return;
      const initial = !snapshot.messages.some(m => m.from === agent);
      const task = !integrating && workspace.writable && isCollaborating(snapshot) ? snapshot.decisions.find(d => d.kind === 'plan')?.tasks.find(t => t.owner === agent && !Object.hasOwn(snapshot.completedTasks, t.id) && t.dependsOn.every(id => Object.hasOwn(snapshot.completedTasks, id))) : undefined;
      const joining = initial && this.ids().length > 1 && snapshot.messages.some(message => this.ids().includes(message.from));
      const delivery = buildContextDelivery(snapshot, agent, memory);
      this.state.session.contextCursors ??= {};
      this.state.session.contextCursors[agent] = delivery.cursor;
      this.save();
      const prompt = delivery.prompt + (integrating ? integrationPrompt(snapshot) : (isCollaborating(snapshot) && initial && this.ids().length > 1 ? joining ? '\nJOINING EXISTING CONVERSATION: review the shared history and contribute your perspective. Do not propose or vote on decisions in this first turn. Yield if no peer response is needed, or finish if the exchange is complete.' : '\nINITIAL INDEPENDENT EXPLORATION: give your own initial thoughts. Do not propose or vote on decisions in this first turn. Yield if no peer response is needed, or finish if the exchange is complete; otherwise you will see your peer’s thoughts next.' : '') + (task && !isCollaborating(snapshot) ? `\nOnly if the user requests implementation, your authorized task is: ${JSON.stringify(task)}. Do not resume pending work merely because a task exists. Do not start sibling tasks.` : task ? `\nYour only active implementation task this turn: ${JSON.stringify(task)}. Do not start sibling tasks. Verify this task, then return complete_task for this id. Do not revise the accepted plan while implementing.` : ''));
      const reply = await this.providers[agent].run({ agent, prompt, ...workspace, permissions: sessionPermissions(snapshot), sessionId: snapshot.providerSessions[agent], model: snapshot.models?.[agent], effort: snapshot.efforts?.[agent], title: nativeSessionTitle(snapshot, agent), signal: abort.signal }, event => {
        if (ticket !== this.tickets[agent] || abort.signal.aborted) return;
        if (event.type === 'text') { this.state.streams[agent] = (this.state.streams[agent] + event.text).slice(-40_000); this.notify(); }
        else if (event.type === 'activity') this.activity(agent, event.text, 'tool');
        else if (event.type === 'session') {
          this.state.session.providerSessions[agent] = event.sessionId; this.save();
          // Never continue a delta-only prompt in an unexpectedly replaced native thread.
          if (!snapshot.demo && !delivery.bootstrap && snapshot.providerSessions[agent] !== event.sessionId) {
            this.tickets[agent]++; abort.abort();
            this.activity(agent, 'Native conversation changed; restoring context before continuing.');
          }
        }
        else if (event.type === 'tool_boundary' && this.queued.has(agent)) { this.queued.delete(agent); this.tickets[agent]++; abort.abort(); this.activity(agent, 'Queued steering delivered at tool boundary.'); }
      });
      if (ticket !== this.tickets[agent] || abort.signal.aborted) return;
      // A turn with no further tools must still consume queued steering before
      // its result can declare agreement/completion.
      if (this.queued.has(agent)) { this.queued.delete(agent); this.tickets[agent]++; return; }
      if (task && reply.actions.some(a => (a.type === 'complete_task' && a.id !== task.id) || (a.type === 'propose' && a.kind === 'plan'))) throw new Error('A writable turn may only complete its assigned task and cannot revise the active plan');
      return { reply, ticket, inputRevision, context: delivery.cursor, inputHash: this.inputHash(snapshot, agent) };
    } catch (error) {
      if (abort.signal.aborted || ticket !== this.tickets[agent]) return;
      this.activity(agent, error instanceof Error ? error.message : String(error), 'error');
      throw error;
    } finally { if (this.aborts.get(agent) === abort) { this.aborts.delete(agent); this.state.busy[agent] = false; this.notify(); } }
  }
}
