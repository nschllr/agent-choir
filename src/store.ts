import { agentIds, validateAgents } from './agents.js';
import type { AgentConfig } from './types.js';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from './types.js';

export type SessionSummary = Pick<Session, 'id' | 'brief' | 'status' | 'scope' | 'updatedAt' | 'project' | 'demo'>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const stringRecord = (value: unknown): boolean => isRecord(value) && Object.values(value).every(item => typeof item === 'string');
const member = (value: unknown, choices: string[]) => typeof value === 'string' && choices.includes(value);

function validId(id: string): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid session ID');
}

/** Reject malformed persisted snapshots before they reach the scheduler or UI. */
function validate(value: unknown): asserts value is Session {
  const invalid = () => { throw new Error('Invalid session snapshot'); };
  if (!isRecord(value)) return invalid();
  for (const key of ['id', 'createdAt', 'updatedAt', 'project', 'brief']) if (typeof value[key] !== 'string') return invalid();
  validId(value.id as string);
  if (value.agents !== undefined) { try { validateAgents(value.agents as AgentConfig[]); } catch { return invalid(); } }
  const agents = agentIds({ agents: value.agents as AgentConfig[] | undefined });
  if (value.interaction !== undefined && !member(value.interaction, ['chat', 'collaborate'])) return invalid();
  if (value.pendingRecipients !== undefined && (!Array.isArray(value.pendingRecipients) || !value.pendingRecipients.every(agent => member(agent, agents)) || new Set(value.pendingRecipients).size !== value.pendingRecipients.length)) return invalid();
  if (!member(value.scope, ['discuss', 'plan', 'build']) || !member(value.status, ['paused', 'running', 'waiting_user', 'complete', 'error']) || typeof value.demo !== 'boolean') return invalid();
  for (const key of ['turns', 'maxTurns', 'maxMinutes', 'elapsedMs']) if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0) return invalid();
  if (!stringRecord(value.completedTasks) || !stringRecord(value.finished) || !stringRecord(value.providerSessions)) return invalid();
  for (const key of ['finished', 'providerSessions']) if (!Object.keys(value[key] as Record<string, unknown>).every(agent => agents.includes(agent))) return invalid();
  if (value.yieldedInputs !== undefined && (!isRecord(value.yieldedInputs) || !Object.entries(value.yieldedInputs).every(([agent, hash]) => agents.includes(agent) && typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)))) return invalid();
  if (value.contextCursors !== undefined) {
    if (!isRecord(value.contextCursors)) return invalid();
    for (const [agent, cursor] of Object.entries(value.contextCursors)) {
      if (!agents.includes(agent) || !isRecord(cursor) || !['nativeSessionId', 'version', 'configuration'].every(key => typeof cursor[key] === 'string') || typeof cursor.inFlight !== 'boolean' || !stringRecord(cursor.messages) || !stringRecord(cursor.memory)) return invalid();
      if (cursor.contextDirectory !== undefined && typeof cursor.contextDirectory !== 'string') return invalid();
      if (typeof cursor.state !== 'string' && (!isRecord(cursor.state) || Object.keys(cursor.state).length !== 3 || !['decisions', 'completedTasks', 'finished'].every(key => Object.hasOwn(cursor.state as object, key)))) return invalid();
      const stateHashes = typeof cursor.state === 'string' ? [cursor.state] : Object.values(cursor.state as Record<string, unknown>);
      if (![cursor.configuration, ...stateHashes, ...Object.values(cursor.messages as Record<string, string>), ...Object.values(cursor.memory as Record<string, string>)].every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) return invalid();
    }
  }
  if (value.providerModels !== undefined && (!isRecord(value.providerModels) || !Object.entries(value.providerModels).every(([provider, model]) => member(provider, ['claude', 'codex']) && typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)))) return invalid();
  if (value.models !== undefined && (!isRecord(value.models) || !Object.entries(value.models).every(([agent, model]) => member(agent, agents) && typeof model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)))) return invalid();
  if (value.awaitingInput !== undefined && typeof value.awaitingInput !== 'boolean') return invalid();
  if (value.error !== undefined && typeof value.error !== 'string') return invalid();
  if (value.integration !== undefined && (!isRecord(value.integration) || !member(value.integration.status, ['pending', 'review', 'conflicts', 'accepted']) ||
    (value.integration.path !== undefined && typeof value.integration.path !== 'string') || (value.integration.notes !== undefined && typeof value.integration.notes !== 'string'))) return invalid();
  if (!Array.isArray(value.messages) || !value.messages.every(item => isRecord(item) && ['id', 'at', 'text'].every(key => typeof item[key] === 'string') && member(item.from, ['user', 'system', ...agents]) && member(item.to, ['both', ...agents]) && (item.delivery === undefined || (item.delivery === 'display-only' && member(item.from, ['system', ...agents]))))) return invalid();
  if (!Array.isArray(value.activities) || !value.activities.every(item => isRecord(item) && ['id', 'at', 'text'].every(key => typeof item[key] === 'string') && member(item.agent, agents) && member(item.kind, ['tool', 'status', 'error']))) return invalid();
  if (!Array.isArray(value.decisions)) return invalid();
  for (const decision of value.decisions) {
    if (!isRecord(decision) || !['id', 'title', 'proposal'].every(key => typeof decision[key] === 'string') || !member(decision.kind, ['plan', 'decision']) || !member(decision.status, ['open', 'agreed', 'waiting_user'])) return invalid();
    if (!Number.isInteger(decision.version) || (decision.version as number) < 1 || !Number.isInteger(decision.rounds) || (decision.rounds as number) < 0) return invalid();
    if (decision.userResolution !== undefined && typeof decision.userResolution !== 'string') return invalid();
    if (decision.needsRevision !== undefined && typeof decision.needsRevision !== 'boolean') return invalid();
    if (!Array.isArray(decision.tasks) || !decision.tasks.every(task => isRecord(task) && typeof task.id === 'string' && typeof task.description === 'string' && member(task.owner, agents) && Array.isArray(task.dependsOn) && task.dependsOn.every(id => typeof id === 'string'))) return invalid();
    if (!isRecord(decision.positions) || !Object.entries(decision.positions).every(([agent, position]) => member(agent, agents) && isRecord(position) && member(position.position, ['accept', 'object', 'evidence']) && typeof position.reason === 'string' && Number.isInteger(position.version) && (position.version as number) > 0)) return invalid();
  }
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw new Error(`State directory must be a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

export class SessionStore {
  private readonly db: DatabaseSync;
  private readonly locksDir: string;
  private readonly releases = new Set<() => void>();
  private closed = false;

  constructor(readonly stateDir: string) {
    privateDirectory(stateDir);
    this.locksDir = join(stateDir, 'locks');
    privateDirectory(this.locksDir);
    const dbPath = join(stateDir, 'session.db');
    if (!existsSync(dbPath)) closeSync(openSync(dbPath, 'wx', 0o600));
    if (!lstatSync(dbPath).isFile()) throw new Error('Session database must be a regular file');
    chmodSync(dbPath, 0o600);
    this.db = new DatabaseSync(dbPath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL, updated_at TEXT NOT NULL)');
    } catch (error) { this.db.close(); throw new Error(`Cannot open session database: ${error instanceof Error ? error.message : String(error)}`); }
  }

  save(session: Session): void {
    validate(session);
    this.db.prepare('INSERT INTO sessions (id, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at').run(session.id, JSON.stringify(session), session.updatedAt);
  }

  private decode(snapshot: string, id: string): Session {
    try {
      const parsed: unknown = JSON.parse(snapshot);
      validate(parsed);
      if (parsed.id !== id) throw new Error('Snapshot ID does not match its database record');
      return parsed;
    } catch (error) { throw new Error(`Corrupted session ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  load(id: string): Session | undefined {
    validId(id);
    const row = this.db.prepare('SELECT snapshot FROM sessions WHERE id = ?').get(id) as { snapshot: string } | undefined;
    if (!row) return undefined;
    const session = this.decode(row.snapshot, id);
    if (session.status === 'running') {
      const at = new Date().toISOString();
      session.status = 'paused'; session.updatedAt = at;
      session.messages.push({ id: randomUUID(), at, from: 'system', to: 'both', text: 'Recovered an interrupted session. Work is paused; resume explicitly when ready.' });
    }
    return session;
  }

  list(): SessionSummary[] {
    const rows = this.db.prepare('SELECT id, snapshot FROM sessions ORDER BY updated_at DESC, id').all() as Array<{ id: string; snapshot: string }>;
    return rows.map(row => {
      const { id, brief, status, scope, updatedAt, project, demo } = this.decode(row.snapshot, row.id);
      return { id, brief, status, scope, updatedAt, project, demo };
    });
  }

  /** One owner per session, including separate opens in the same process. */
  acquire(id: string): () => void {
    validId(id);
    if (this.closed) throw new Error('Session store is closed');
    const path = join(this.locksDir, `${id}.lock`);
    const token = randomUUID();
    for (let attempt = 0; attempt < 5; attempt++) {
      let fd: number;
      try { fd = openSync(path, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let existing;
        try { existing = lstatSync(path); }
        catch (checkError) { if ((checkError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw checkError; }
        if (!existing.isFile()) throw new Error(`Invalid session lock for ${id}`);
        let lock: unknown;
        try { lock = JSON.parse(readFileSync(path, 'utf8')); }
        catch (readError) { if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new Error(`Unreadable session lock for ${id}; inspect ${path} before removing it`); }
        if (!isRecord(lock) || !Number.isInteger(lock.pid) || (lock.pid as number) <= 0 || typeof lock.token !== 'string') throw new Error(`Invalid session lock for ${id}`);
        if (processAlive(lock.pid as number)) throw new Error(`Session ${id} is already open in process ${lock.pid}`);
        // Serialize stale-lock reclamation. A second reclaimer must recheck the
        // inode after taking this guard, so it cannot unlink a newly acquired lock.
        const guardPath = `${path}.reclaim`;
        let guard: number;
        try { guard = openSync(guardPath, 'wx', 0o600); }
        catch (guardError) { if ((guardError as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Session ${id} lock recovery is busy; retry or inspect ${guardPath}`); throw guardError; }
        closeSync(guard);
        try {
          const current = lstatSync(path);
          const currentLock: unknown = JSON.parse(readFileSync(path, 'utf8'));
          if (current.ino === existing.ino && current.dev === existing.dev && isRecord(currentLock) && currentLock.token === lock.token) unlinkSync(path);
        } catch (checkError) { if ((checkError as NodeJS.ErrnoException).code !== 'ENOENT') throw checkError; }
        finally { unlinkSync(guardPath); }
        continue;
      }
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })); }
      catch (error) { closeSync(fd); unlinkSync(path); throw error; }
      closeSync(fd);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.releases.delete(release);
        try {
          const current: unknown = JSON.parse(readFileSync(path, 'utf8'));
          if (isRecord(current) && current.token === token) unlinkSync(path);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      };
      this.releases.add(release);
      return release;
    }
    throw new Error(`Session ${id} lock changed repeatedly; retry opening it`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { for (const release of [...this.releases]) release(); }
    finally { this.db.close(); }
  }
}
