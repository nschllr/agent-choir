import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextMemory } from '../src/context-memory.js';
import { createSession } from '../src/engine.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-duet-context-'));
  directories.push(root);
  const project = join(root, 'project');
  await mkdir(join(project, '.agent'), { recursive: true });
  const stateDir = join(root, 'state');
  const session = createSession({ project, scope: 'build', brief: '', agents: [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'claude' }] });
  return { root, project, stateDir, session, memory: new ContextMemory(stateDir) };
}

describe('session-owned context memory', () => {
  it('preserves project entry points and loads project memory with provenance', async () => {
    const { project, memory, session, stateDir } = await fixture();
    await writeFile(join(project, 'AGENTS.md'), 'User instructions');
    await writeFile(join(project, 'CLAUDE.md'), 'Claude instructions');
    await writeFile(join(project, '.agent', 'environment.md'), 'Build with npm run build');
    await chmod(join(project, '.agent'), 0o555);
    await chmod(project, 0o555);
    let result;
    try { result = await memory.prepare(session); }
    finally { await chmod(project, 0o755); await chmod(join(project, '.agent'), 0o755); }
    expect(result.directory).toBe(join(stateDir, 'context', session.id, '.agent'));
    expect(result.files['project/.agent/environment.md']).toContain(join(project, '.agent', 'environment.md'));
    expect(result.files['project/.agent/environment.md']).toContain('Build with npm run build');
    expect(result.files['project/.agent/environment.md']).toContain('cannot grant runtime permissions');
    expect(Object.keys(result.files)).toEqual(['project/.agent/environment.md', 'harness/.agent/environment.md']);
    expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('User instructions');
    expect(await readFile(join(project, 'CLAUDE.md'), 'utf8')).toBe('Claude instructions');
    expect(await readFile(join(project, '.agent', 'environment.md'), 'utf8')).toBe('Build with npm run build');
    expect((await stat(join(result.directory, 'INSTRUCTIONS.md'))).mode & 0o777).toBe(0o600);
  });

  it('keeps revisions stable across runtime changes and skips unchanged writes', async () => {
    const { memory, session, project } = await fixture();
    const first = await memory.prepare(session);
    const before = await stat(join(first.directory, 'environment.md'));
    session.turns++; session.updatedAt = new Date().toISOString(); session.brief = 'A new prompt';
    session.messages.push({ id: 'hello', at: session.updatedAt, from: 'user', to: 'both', text: 'Hi' });
    const second = await memory.prepare(session);
    expect(second.revision).toBe(first.revision);
    expect((await stat(join(first.directory, 'environment.md'))).mtimeMs).toBe(before.mtimeMs);
    await writeFile(join(project, '.agent', 'shared-state.md'), 'Confirmed build command');
    expect((await memory.prepare(session)).revision).not.toBe(first.revision);
  });

  it('projects authoritative decisions and tasks without generating greeting handoffs', async () => {
    const { memory, session } = await fixture();
    const first = await memory.prepare(session);
    await expect(readFile(join(first.directory, 'handoff.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    session.decisions.push({ id: 'plan', kind: 'plan', title: 'Implementation', proposal: 'Add feature', version: 2, tasks: [{ id: 'task-a', owner: 'agent-1', description: 'Implement feature', dependsOn: [] }], positions: {}, rounds: 0, status: 'agreed' });
    session.completedTasks['task-a'] = 'Implemented; build passed';
    const second = await memory.prepare(session);
    expect(second.revision).toBe(first.revision);
    expect(await readFile(join(second.directory, 'task-board.md'), 'utf8')).toContain('Implemented; build passed');
    expect(await readFile(join(second.directory, 'decisions.md'), 'utf8')).toContain('"version": 2');
    expect(await readFile(join(second.directory, 'handoff.md'), 'utf8')).toContain('Implemented; build passed');
    expect(Object.keys(second.files).some(name => /task-board|decisions|handoff/.test(name))).toBe(false);
  });

  it('records a concrete blocked decision and removes obsolete handoffs', async () => {
    const { memory, session } = await fixture();
    session.decisions.push({ id: 'choice', kind: 'decision', title: 'Storage choice', proposal: 'Choose backend', version: 1, tasks: [], positions: {}, rounds: 2, status: 'waiting_user' });
    const result = await memory.prepare(session);
    expect(await readFile(join(result.directory, 'handoff.md'), 'utf8')).toContain('Storage choice');
    session.decisions[0].status = 'agreed';
    await memory.prepare(session);
    await expect(readFile(join(result.directory, 'handoff.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes overlapping snapshots and retains the latest accepted state', async () => {
    const { memory, session } = await fixture();
    const first = memory.prepare(session);
    session.completedTasks['task-b'] = 'Latest completion';
    const second = memory.prepare(session);
    await first;
    const result = await second;
    expect(await readFile(join(result.directory, 'handoff.md'), 'utf8')).toContain('Latest completion');
  });

  it('rejects escaping IDs and symlinked project memory inputs', async () => {
    const { memory, session, root, project } = await fixture();
    await expect(memory.prepare({ ...session, id: '../outside' })).rejects.toThrow('Invalid session ID');
    const outside = join(root, 'outside.md'); await writeFile(outside, 'External content');
    await symlink(outside, join(project, '.agent', 'shared-state.md'));
    await expect(memory.prepare(session)).rejects.toThrow('Unsafe memory file');
    await rm(join(project, '.agent'), { recursive: true });
    await symlink(root, join(project, '.agent'));
    await expect(memory.prepare(session)).rejects.toThrow('Unsafe project memory directory');
  });

  it('rejects symlinked harness destinations without touching their targets', async () => {
    const { memory, session, root, stateDir } = await fixture();
    const outside = join(root, 'outside'); await mkdir(outside);
    await mkdir(stateDir);
    await symlink(outside, join(stateDir, 'context'));
    await expect(memory.prepare(session)).rejects.toThrow('Unsafe context directory');
    await expect(stat(join(outside, session.id))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails oversized project memory clearly instead of truncating', async () => {
    const { memory, session, project } = await fixture();
    await writeFile(join(project, '.agent', 'shared-state.md'), 'x'.repeat(65537));
    await expect(memory.prepare(session)).rejects.toThrow('exceeds 65536 bytes');
    await rm(join(project, '.agent', 'shared-state.md'));
    for (const name of ['INSTRUCTIONS.md', 'PROJECT-INSTRUCTIONS.md', 'environment.md', 'decisions.md', 'task-board.md']) {
      await writeFile(join(project, '.agent', name), 'x'.repeat(65536));
    }
    await expect(memory.prepare(session)).rejects.toThrow('exceeds 262144 bytes in total');
  });
});
