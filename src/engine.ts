import { randomUUID } from 'node:crypto';
import { type AgentConfig, type AgentId, type AgentReply, type Decision, type Scope, type Session, type TaskSpec } from './types.js';
import { agentIds, isCollaborating, validateAgents } from './agents.js';
import { parseReply } from './protocol.js';
import { buildContextDelivery } from './context-delivery.js';

export interface SessionOptions { project: string; scope?: Scope; brief: string; demo?: boolean; maxTurns?: number; maxMinutes?: number; agents?: AgentConfig[]; interaction?: Session['interaction'] }
export function createSession(options: SessionOptions): Session {
  const scope = options.scope ?? (options.demo ? 'discuss' : 'build');
  if (options.agents !== undefined) validateAgents(options.agents);
  if (options.interaction !== undefined && !['chat', 'collaborate'].includes(options.interaction)) throw new Error('Invalid interaction mode');
  if (!options.project?.trim() || (typeof options.brief !== 'string' || (!options.brief.trim() && options.agents === undefined)) || !['discuss', 'plan', 'build'].includes(scope)) throw new Error('Project, brief and valid scope are required');
  for (const n of [options.maxTurns ?? 30, options.maxMinutes ?? 30]) if (!Number.isFinite(n) || n <= 0) throw new Error('Limits must be positive');
  if (!Number.isInteger(options.maxTurns ?? 30)) throw new Error('maxTurns must be an integer');
  const at = new Date().toISOString();
  const interaction = options.interaction ?? (options.agents === undefined ? undefined : 'chat');
  const collaborating = isCollaborating({ agents: options.agents, interaction });
  const recipient = collaborating ? 'both' : agentIds({ agents: options.agents })[0];
  return { id: randomUUID(), createdAt: at, updatedAt: at, project: options.project, scope, brief: options.brief,
    ...(options.agents === undefined ? {} : { agents: structuredClone(options.agents), awaitingInput: !options.brief.trim() }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(!collaborating ? { pendingRecipients: options.brief.trim() ? [recipient] : [], awaitingInput: !options.brief.trim() } : {}),
    status: 'paused', messages: options.brief.trim() ? [{ id: randomUUID(), at, from: 'user', to: recipient, text: options.brief }] : [], activities: [], decisions: [], completedTasks: {}, finished: {}, providerSessions: {},
    turns: 0, maxTurns: options.maxTurns ?? 30, maxMinutes: options.maxMinutes ?? 30, elapsedMs: 0, demo: options.demo ?? false };
}
function validateTasks(tasks: TaskSpec[], agents: AgentId[]): void {
  if (tasks.some(task => !agents.includes(task.owner))) throw new Error('Unknown task owner');
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length) throw new Error('Duplicate task ids');
  const visiting = new Set<string>(), done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Task dependency cycle');
    if (done.has(id)) return;
    visiting.add(id);
    const t = byId.get(id)!;
    if (new Set(t.dependsOn).size !== t.dependsOn.length) throw new Error('Duplicate dependencies');
    for (const dep of t.dependsOn) { if (!byId.has(dep)) throw new Error('Unknown task dependency'); visit(dep); }
    visiting.delete(id); done.add(id);
  };
  for (const id of byId.keys()) visit(id);
}
const plan = (s: Session) => s.decisions.find(d => d.kind === 'plan');
export function canImplement(s: Session): boolean {
  return s.scope === 'build' && plan(s)?.status === 'agreed' && s.decisions.every(d => d.status === 'agreed') && s.status !== 'complete' && s.status !== 'error';
}
function checkCompletion(s: Session): void {
  const settled = s.decisions.every(d => d.status === 'agreed');
  const hasPlan = s.scope !== 'plan' || plan(s)?.status === 'agreed';
  const tasksDone = s.scope !== 'build' || (plan(s)?.tasks ?? []).every(t => Object.hasOwn(s.completedTasks, t.id));
  if (agentIds(s).every(a => s.finished[a]) && settled && hasPlan && tasksDone) s.status = 'complete';
  else if (s.decisions.some(d => d.status === 'waiting_user')) s.status = 'waiting_user';
}
function countUnresolved(d: Decision): void { d.rounds++; if (d.rounds >= 3) d.status = 'waiting_user'; }
export function applyReply(session: Session, agent: AgentId, input: AgentReply): Session {
  const agents = agentIds(session);
  if (!agents.includes(agent)) throw new Error('Unknown agent');
  if (session.status === 'complete' || session.status === 'error') throw new Error('Session is not accepting replies');
  const reply = parseReply(input), s = structuredClone(session);
  for (const a of reply.actions) {
    if (a.type === 'propose') {
      validateTasks(a.tasks, agents);
      if (a.kind !== 'plan' && a.tasks.length) throw new Error('Only plans can assign tasks');
      let d = s.decisions.find(d => d.id === a.id);
      if (!d && a.kind === 'plan' && plan(s)) throw new Error('Revise the existing plan id');
      if (d) {
        if (d.kind !== a.kind || d.status === 'waiting_user' || (d.kind === 'decision' && d.userResolution !== undefined)) throw new Error('Cannot revise this decision');
        if (Object.keys(s.completedTasks).length && d.kind === 'plan') throw new Error('Cannot revise a plan after task completion');
        // A revision must not erase an objection in a partially completed cycle.
        if (Object.values(d.positions).some(p => p && p.position !== 'accept') && Object.keys(d.positions).length < agents.length) countUnresolved(d);
        d.version++; d.title = a.title; d.proposal = a.proposal; d.tasks = a.tasks; d.positions = {};
        if (d.rounds < 3) d.status = 'open';
        delete d.needsRevision;
      } else {
        d = { ...a, version: 1, positions: {}, rounds: 0, status: 'open' };
        s.decisions.push(d);
      }
      s.finished = {};
    } else if (a.type === 'position') {
      const d = s.decisions.find(d => d.id === a.id);
      if (!d || d.version !== a.version) throw new Error('Unknown decision or stale version');
      if (d.needsRevision) throw new Error('The user resolution requires a concrete revised plan before voting');
      if (d.status !== 'open') throw new Error('Decision is already settled or waiting for user');
      // All current instances close a discussion cycle. The next submission begins another.
      if (agents.every(id => d.positions[id])) d.positions = {};
      if (d.positions[agent]) throw new Error('Position already recorded for this round');
      d.positions[agent] = { position: a.position, reason: a.reason, version: a.version };
      if (agents.every(id => d.positions[id])) {
        if (agents.every(id => d.positions[id]!.position === 'accept')) d.status = 'agreed';
        else countUnresolved(d);
      }
      s.finished = {};
    } else if (a.type === 'complete_task') {
      if (!canImplement(s)) throw new Error('Implementation has not been authorized');
      const t = plan(s)?.tasks.find(t => t.id === a.id);
      if (!t || t.owner !== agent) throw new Error('Unknown task or wrong owner');
      if (Object.hasOwn(s.completedTasks, a.id)) throw new Error('Task already complete');
      if (!t.dependsOn.every(id => Object.hasOwn(s.completedTasks, id))) throw new Error('Task dependencies incomplete');
      s.completedTasks[a.id] = a.summary;
    } else {
      if (s.decisions.some(d => d.status !== 'agreed') || (s.scope === 'plan' && plan(s)?.status !== 'agreed')) throw new Error('Cannot finish with unresolved decisions or no accepted plan');
      if (s.scope === 'build' && !(plan(s)?.tasks ?? []).every(t => Object.hasOwn(s.completedTasks, t.id))) throw new Error('Cannot finish with incomplete tasks');
      s.finished[agent] = a.summary;
    }
  }
  s.updatedAt = new Date().toISOString();
  if (reply.message) s.messages.push({ id: randomUUID(), at: s.updatedAt, from: agent, to: isCollaborating(s) ? agents.find(id => id !== agent) ?? 'both' : agent, text: reply.message });
  s.turns++;
  checkCompletion(s);
  return s;
}
export function resolveDecision(session: Session, id: string, resolution: string): Session {
  if (typeof resolution !== 'string' || !resolution.trim()) throw new Error('Resolution is required');
  const s = structuredClone(session), d = s.decisions.find(d => d.id === id);
  if (!d || d.status !== 'waiting_user') throw new Error('Decision is not waiting for user');
  d.proposal = resolution; d.version++; d.positions = {}; d.userResolution = resolution;
  if (d.kind === 'plan') {
    // A free-text user choice cannot authorize an obsolete implementation graph.
    d.tasks = []; d.needsRevision = true; d.status = 'open'; d.rounds = 0;
  } else d.status = 'agreed';
  s.finished = {}; s.updatedAt = new Date().toISOString();
  s.messages.push({ id: randomUUID(), at: s.updatedAt, from: 'user', to: 'both', text: `Decision ${id} resolved: ${resolution}` });
  s.status = s.decisions.some(d => d.status === 'waiting_user') ? 'waiting_user' : 'paused';
  return s;
}
/** Complete bootstrap prompt for callers without a delivery checkpoint. */
export function buildPrompt(s: Session, agent: AgentId): string {
  return buildContextDelivery(s, agent).prompt;
}
