import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/store.js';
import { createSession } from '../src/engine.js';
import { buildContextDelivery } from '../src/context-delivery.js';

const directories: string[] = [];
const stores: SessionStore[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-duet-store-'));
  directories.push(directory);
  const store = new SessionStore(directory);
  stores.push(store);
  return { directory, store, session: createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Compare storage choices', demo: true }) };
}
afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('durable session store', () => {
  it('persists permission controls and native model/effort defaults across reopening', () => {
    const { store, session } = fixture();
    session.demo = false; session.scope = 'build';
    session.permissions = { mode: 'full', additionalDirectories: ['/tmp'] };
    session.models = { codex: null, claude: 'sonnet[1m]' }; session.efforts = { codex: null, claude: 'high' };
    store.save(session);
    expect(store.load(session.id)).toEqual(session);
    session.scope = 'discuss';
    expect(() => store.save(session)).toThrow('Invalid session');
    session.permissions.mode = 'read-only';
    store.save(session);
    expect(store.load(session.id)?.permissions.mode).toBe('read-only');
  });
  it('restores exact snapshots after reopening and lists their metadata', () => {
    const { directory, store, session } = fixture();
    session.providerSessions = { codex: 'native-session' };
    store.save(session);
    store.close();
    const reopened = new SessionStore(directory);
    stores.push(reopened);
    expect(reopened.load(session.id)).toEqual(session);
    expect(reopened.load('missing')).toBeUndefined();
    expect(reopened.list()).toEqual([{ id: session.id, brief: session.brief, status: 'paused', scope: 'discuss', updatedAt: session.updatedAt, project: session.project, demo: true }]);
  });
  it('recovers interrupted runs as paused without silently overwriting persisted state', () => {
    const { store, session } = fixture();
    session.status = 'running'; store.save(session);
    const recovered = store.load(session.id)!;
    expect(recovered.status).toBe('paused');
    expect(recovered.messages.at(-1)?.from).toBe('system');
    expect(recovered.messages.at(-1)?.text).toContain('resume explicitly');
    expect(store.list()[0]?.status).toBe('running');
    store.save(recovered);
    expect(store.load(session.id)).toEqual(recovered);
  });
  it('protects state and lock files with private permissions', () => {
    const { directory, store, session } = fixture();
    store.save(session); const release = store.acquire(session.id);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, 'session.db')).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, 'locks', `${session.id}.lock`)).mode & 0o777).toBe(0o600);
    release();
  });
  it('rejects simultaneous ownership even in the same process and releases on close', () => {
    const { directory, store, session } = fixture();
    const other = new SessionStore(directory); stores.push(other);
    const release = store.acquire(session.id);
    expect(() => store.acquire(session.id)).toThrow('already open');
    expect(() => other.acquire(session.id)).toThrow('already open');
    release(); release();
    other.acquire(session.id);
    other.close();
    expect(() => store.acquire(session.id)).not.toThrow();
  });
  it('reclaims a dead-process lock but refuses malformed locks', () => {
    const { directory, store, session } = fixture();
    const lock = join(directory, 'locks', `${session.id}.lock`);
    writeFileSync(lock, JSON.stringify({ pid: 2147483647, token: 'dead' }));
    const release = store.acquire(session.id);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    release();
    writeFileSync(lock, 'broken');
    expect(() => store.acquire(session.id)).toThrow('Unreadable session lock');
  });
  it('rejects unsafe IDs and reports corrupt snapshots clearly', () => {
    const { directory, store, session } = fixture();
    expect(() => store.acquire('../outside')).toThrow('Invalid session ID');
    expect(() => store.load('/absolute')).toThrow('Invalid session ID');
    store.save(session);
    const db = new DatabaseSync(join(directory, 'session.db'));
    db.prepare('UPDATE sessions SET snapshot = ? WHERE id = ?').run('{"id":', session.id);
    db.close();
    expect(() => store.load(session.id)).toThrow(`Corrupted session ${session.id}`);
    expect(() => store.list()).toThrow('Corrupted session');
  });
});

it('persists same-provider instances and rejects identities outside their roster', () => {
  const { store, session } = fixture();
  session.agents = [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'codex' }];
  session.providerSessions = { 'agent-1': 'native-one', 'agent-2': 'native-two' };
  session.models = { 'agent-1': 'gpt-5', 'agent-2': 'gpt-5-mini' };
  session.providerModels = { claude: 'claude-haiku-4-5-20251001' };
  session.awaitingInput = true;
  session.messages.push({ id: 'm', at: session.createdAt, from: 'agent-1', to: 'agent-2', text: 'Shared context' });
  store.save(session);
  expect(store.load(session.id)).toEqual(session);
  for (const invalid of [
    { ...session, providerSessions: { codex: 'wrong-instance' } },
    { ...session, finished: { codex: 'finished' } },
    { ...session, models: { codex: 'gpt-5' } },
    { ...session, messages: [{ ...session.messages[0], to: 'codex' }] },
    { ...session, activities: [{ id: 'a', at: session.createdAt, agent: 'codex', kind: 'status', text: 'Bad' }] },
    { ...session, agents: [{ id: '../unsafe', provider: 'codex' }] },
    { ...session, providerModels: { other: 'model' } },
  ]) expect(() => store.save(invalid as typeof session)).toThrow('Invalid session snapshot');
});

it('persists chat routing and rejects malformed recipient queues', () => {
  const { store } = fixture();
  const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Hi', agents: [{ id: 'one', provider: 'codex' }, { id: 'two', provider: 'claude' }] });
  store.save(session);
  expect(store.load(session.id)).toEqual(session);
  for (const pendingRecipients of [['codex'], ['one', 'one'], 'one', [1]]) {
    expect(() => store.save({ ...session, pendingRecipients } as typeof session)).toThrow('Invalid session snapshot');
  }
  expect(() => store.save({ ...session, interaction: 'invalid' } as unknown as typeof session)).toThrow('Invalid session snapshot');
  const old = { ...session };
  delete old.interaction;
  delete old.pendingRecipients;
  store.save(old);
  expect(store.load(old.id)).toEqual(old);
});

it('preserves in-flight delivery checkpoints and rejects corrupt cursor records', () => {
  const { store, session } = fixture();
  const { cursor } = buildContextDelivery(session, 'codex');
  session.contextCursors = { codex: cursor };
  store.save(session);
  expect(store.load(session.id)?.contextCursors).toEqual({ codex: cursor });
  for (const contextCursors of [[], { outsider: cursor }, { codex: null },
    { codex: { ...cursor, state: 'bad-hash' } },
    { codex: { ...cursor, state: {} } },
    { codex: { ...cursor, state: { decisions: 'a'.repeat(64), completedTasks: 'a'.repeat(64), finished: 'invalid' } } },
    { codex: { ...cursor, contextDirectory: 42 } },
    { codex: { ...cursor, messages: { missing: 3 } } },
    { codex: { ...cursor, memory: [] } },
    { codex: { ...cursor, inFlight: 'false' } },
  ]) expect(() => store.save({ ...session, contextCursors } as typeof session)).toThrow('Invalid session snapshot');
  session.contextCursors.codex = { ...cursor, state: 'a'.repeat(64) };
  store.save(session);
  expect(store.load(session.id)?.contextCursors).toEqual(session.contextCursors);
  delete session.contextCursors;
  store.save(session);
  expect(store.load(session.id)).toEqual(session);
});

it('preserves yield checkpoints and display-only notices with strict validation', () => {
  const { store, session } = fixture();
  session.yieldedInputs = { codex: 'a'.repeat(64) };
  session.messages.push({ id: 'stop', from: 'codex', to: 'claude', at: '', text: 'No reply needed', delivery: 'display-only' },
    { id: 'notice', from: 'system', to: 'both', at: '', text: 'Waiting for input', delivery: 'display-only' });
  store.save(session);
  expect(store.load(session.id)).toEqual(session);
  for (const yieldedInputs of [[], { unknown: 'a'.repeat(64) }, { codex: 'invalid' }]) {
    expect(() => store.save({ ...session, yieldedInputs } as typeof session)).toThrow('Invalid session snapshot');
  }
  for (const message of [{ ...session.messages[0], delivery: 'invalid' }, { ...session.messages[0], delivery: 'display-only' }]) {
    expect(() => store.save({ ...session, messages: [message] } as typeof session)).toThrow('Invalid session snapshot');
  }
});
