import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitWorkspaceManager } from '../src/workspaces.js';
import { DuetController } from '../src/controller.js';
import { SessionStore } from '../src/store.js';
import { createSession } from '../src/engine.js';
import type { Session, TaskSpec } from '../src/types.js';

const exec = promisify(execFile), dirs: string[] = [];
const git = async (cwd: string, ...args: string[]) => (await exec('git', ['-c', 'user.name=Tests', '-c', 'user.email=tests@localhost', '-c', 'commit.gpgSign=false', ...args], { cwd })).stdout.trim();
async function fixture(tasks?: TaskSpec[]) {
  const root = await mkdtemp(join(tmpdir(), 'duet-workspaces-')); dirs.push(root);
  const project = join(root, 'project'); await mkdir(project);
  await git(project, 'init', '-b', 'main');
  await writeFile(join(project, 'shared.txt'), 'original\n');
  await git(project, 'add', '.'); await git(project, 'commit', '-m', 'Initial');
  const s = createSession({ project, scope: 'build', brief: 'Build' });
  s.status = 'running';
  s.decisions = [{ id: 'plan', kind: 'plan', title: 'Plan', proposal: 'Implement', version: 1, positions: {}, rounds: 0, status: 'agreed', tasks: tasks ?? [
    { id: 'a', owner: 'claude', description: 'a', dependsOn: [] },
    { id: 'b', owner: 'codex', description: 'b', dependsOn: [] },
  ] }];
  const stateDir = join(root, 'state');
  return { root, project, s, stateDir, manager: new GitWorkspaceManager(stateDir), base: await git(project, 'rev-parse', 'HEAD') };
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('isolated build workspaces', () => {
  it('completes conflict resolution and peer review through the controller while preserving the original checkout', async () => {
    const f = await fixture();
    const first = await f.manager.prepare(f.s, 'claude'), second = await f.manager.prepare(f.s, 'codex');
    await writeFile(join(first.cwd, 'shared.txt'), 'First implementation\n');
    await writeFile(join(second.cwd, 'shared.txt'), 'Second implementation\n');
    f.s.completedTasks = { a: 'Done', b: 'Done' };
    await f.manager.finalize(f.s, 'claude'); await f.manager.finalize(f.s, 'codex');
    f.s.finished = { claude: 'Done', codex: 'Done' }; f.s.integration = { status: 'pending' }; f.s.status = 'paused';
    const store = new SessionStore(join(f.root, 'sessions'));
    const controller = new DuetController(f.s, {
      claude: { id: 'claude', async dispose() {}, async run(turn) {
        expect(turn.writable).toBe(true);
        expect(turn.cwd).not.toBe(f.project);
        expect(await readFile(join(turn.cwd, 'shared.txt'), 'utf8')).toContain('<<<<<<<');
        await writeFile(join(turn.cwd, 'shared.txt'), 'Combined implementation\n');
        return { message: 'Resolved both implementations and checked the combined behavior.', actions: [{ type: 'integration_report', outcome: 'ready', revision: '', summary: 'Combined behavior validated on the fixture.' }] };
      } },
      codex: { id: 'codex', async dispose() {}, async run(turn) {
        expect(turn.writable).toBe(false);
        expect(await readFile(join(turn.cwd, 'shared.txt'), 'utf8')).toBe('Combined implementation\n');
        return { message: 'Both implementations are represented.', actions: [{ type: 'integration_report', outcome: 'accept', revision: await git(turn.cwd, 'rev-parse', 'HEAD'), summary: 'Reviewed both task diffs and the resolved content.' }] };
      } },
    }, store, f.manager);
    try {
      await controller.start(); await controller.wait();
      expect(controller.getView().session).toMatchObject({ status: 'complete', integration: { status: 'accepted', owner: 'claude', reviewer: 'codex' } });
      expect(store.load(f.s.id)?.integration?.status).toBe('accepted');
      expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('original\n');
      expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
      expect(await git(f.project, 'status', '--porcelain')).toBe('');
    } finally { await controller.close(); store.close(); }
  });
  it('allows direct project editing without a plan, clean Git state or even a repository', async () => {
    const f = await fixture();
    f.s.interaction = 'chat'; f.s.decisions = [];
    await writeFile(join(f.project, 'dirty.txt'), 'existing user changes');
    expect(await f.manager.prepare(f.s, 'codex')).toEqual({ cwd: f.project, writable: true });
    const plain = join(f.root, 'plain'); await mkdir(plain);
    f.s.project = plain;
    expect(await f.manager.prepare(f.s, 'codex')).toEqual({ cwd: plain, writable: true });
    f.s.scope = 'discuss';
    expect(await f.manager.prepare(f.s, 'codex')).toEqual({ cwd: plain, writable: false });
  });
  it('returns the original read-only workspace before mutual agreement', async () => {
    const { s, manager, project } = await fixture();
    s.decisions[0].status = 'open';
    expect(await manager.prepare(s, 'claude')).toEqual({ cwd: project, writable: false });
    s.scope = 'discuss';
    await writeFile(join(project, 'dirty.txt'), 'uncommitted');
    expect(await manager.prepare(s, 'codex')).toEqual({ cwd: project, writable: false });
  });
  it('refuses non-repository and empty repositories for build preparation', async () => {
    const f = await fixture();
    const empty = join(f.root, 'empty'); await mkdir(empty);
    const s: Session = { ...f.s, project: empty };
    await expect(f.manager.prepare(s, 'claude')).rejects.toThrow(/HEAD/);
    await git(empty, 'init');
    await expect(f.manager.prepare(s, 'claude')).rejects.toThrow(/HEAD/);
  });
  it('snapshots current dirty files for both peers while preserving the original checkout and index', async () => {
    const f = await fixture();
    await writeFile(join(f.project, '.gitignore'), 'ignored.txt\nforced.txt\n');
    await writeFile(join(f.project, 'deleted.txt'), 'delete me\n');
    await git(f.project, 'add', '.'); await git(f.project, 'commit', '-m', 'Baseline files');
    const head = await git(f.project, 'rev-parse', 'HEAD');
    await writeFile(join(f.project, 'shared.txt'), 'staged user change\n');
    await git(f.project, 'add', 'shared.txt');
    await writeFile(join(f.project, 'shared.txt'), 'current user change\n');
    await rm(join(f.project, 'deleted.txt'));
    const unusualName = ' new [file]\n.txt';
    await writeFile(join(f.project, unusualName), 'untracked user change\n');
    await writeFile(join(f.project, 'ignored.txt'), 'ignored local data\n');
    await writeFile(join(f.project, 'forced.txt'), 'staged ignored file\n');
    await git(f.project, 'add', '--force', 'forced.txt');
    const index = await readFile(join(f.project, '.git', 'index'));
    const first = await f.manager.prepare(f.s, 'claude');
    const second = await f.manager.prepare(f.s, 'codex');
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(f.project, 'branch', '--show-current')).toBe('main');
    expect(await git(f.project, 'show', ':shared.txt')).toBe('staged user change');
    for (const workspace of [first, second]) {
      expect(workspace.writable).toBe(true);
      expect(await readFile(join(workspace.cwd, 'shared.txt'), 'utf8')).toBe('current user change\n');
      expect(await readFile(join(workspace.cwd, unusualName), 'utf8')).toBe('untracked user change\n');
      expect(await readFile(join(workspace.cwd, 'forced.txt'), 'utf8')).toBe('staged ignored file\n');
      await expect(readFile(join(workspace.cwd, 'deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(readFile(join(workspace.cwd, 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await git(workspace.cwd, 'status', '--porcelain')).toBe('');
    }
    expect(await git(first.cwd, 'rev-parse', 'HEAD')).toBe(await git(second.cwd, 'rev-parse', 'HEAD'));
    await writeFile(join(first.cwd, 'claude-fix.txt'), 'fix assigned to Claude\n');
    await writeFile(join(second.cwd, 'codex-fix.txt'), 'fix assigned to Codex\n');
    f.s.completedTasks = { a: 'fixed', b: 'fixed' };
    await f.manager.finalize(f.s, 'claude'); await f.manager.finalize(f.s, 'codex');
    const integrated = await f.manager.merge(f.s);
    expect(integrated.conflicts).toBe(false);
    expect(await readFile(join(integrated.path, 'shared.txt'), 'utf8')).toBe('current user change\n');
    expect(await readFile(join(integrated.path, unusualName), 'utf8')).toBe('untracked user change\n');
    expect(await readFile(join(integrated.path, 'forced.txt'), 'utf8')).toBe('staged ignored file\n');
    await expect(readFile(join(integrated.path, 'deleted.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(integrated.path, 'claude-fix.txt'), 'utf8')).toBe('fix assigned to Claude\n');
    expect(await readFile(join(integrated.path, 'codex-fix.txt'), 'utf8')).toBe('fix assigned to Codex\n');
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('current user change\n');
    expect(await readFile(join(f.project, 'ignored.txt'), 'utf8')).toBe('ignored local data\n');
    await expect(readFile(join(f.project, 'claude-fix.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.project, 'codex-fix.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(head);
  });
  it('reuses the first snapshot after resume and preserves unfinished agent edits', async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'shared.txt'), 'initial dirty review input\n');
    const first = await f.manager.prepare(f.s, 'claude');
    const baseline = await git(first.cwd, 'rev-parse', 'HEAD');
    await writeFile(join(first.cwd, 'unfinished.txt'), 'agent work interrupted by a crash\n');
    await writeFile(join(f.project, 'shared.txt'), 'later user changes\n');
    const restarted = new GitWorkspaceManager(f.stateDir);
    expect(await restarted.prepare(f.s, 'claude')).toEqual(first);
    expect(await readFile(join(first.cwd, 'unfinished.txt'), 'utf8')).toBe('agent work interrupted by a crash\n');
    const second = await restarted.prepare(f.s, 'codex');
    expect(await git(second.cwd, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(await readFile(join(second.cwd, 'shared.txt'), 'utf8')).toBe('initial dirty review input\n');
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('later user changes\n');
  });
  it('recovers a durable snapshot after a crash before workspace metadata was persisted', async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'shared.txt'), 'snapshot before crash\n');
    const first = await f.manager.prepare(f.s, 'claude');
    const baseline = await git(first.cwd, 'rev-parse', 'HEAD');
    expect(await git(f.project, 'rev-parse', `refs/duet/${f.s.id}/base`)).toBe(baseline);
    await rm(join(f.stateDir, 'worktrees', f.s.id, 'workspace.json'));
    await writeFile(join(f.project, 'shared.txt'), 'later user changes\n');
    const restarted = new GitWorkspaceManager(f.stateDir);
    expect(await restarted.prepare(f.s, 'claude')).toEqual(first);
    const second = await restarted.prepare(f.s, 'codex');
    expect(await git(second.cwd, 'rev-parse', 'HEAD')).toBe(baseline);
    expect(await readFile(join(second.cwd, 'shared.txt'), 'utf8')).toBe('snapshot before crash\n');
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('later user changes\n');
  });
  it('captures filesystem contents despite index flags and omits staged additions removed from disk', async () => {
    const f = await fixture();
    await writeFile(join(f.project, 'assumed.txt'), 'committed version\n');
    await git(f.project, 'add', 'assumed.txt'); await git(f.project, 'commit', '-m', 'Another tracked file');
    await git(f.project, 'update-index', '--skip-worktree', 'shared.txt');
    await git(f.project, 'update-index', '--assume-unchanged', 'assumed.txt');
    await writeFile(join(f.project, 'shared.txt'), 'current skipped file\n');
    await writeFile(join(f.project, 'assumed.txt'), 'current assumed file\n');
    await writeFile(join(f.project, 'removed-addition.txt'), 'staged then removed\n');
    await git(f.project, 'add', 'removed-addition.txt');
    await rm(join(f.project, 'removed-addition.txt'));
    const index = await readFile(join(f.project, '.git', 'index'));
    const workspace = await f.manager.prepare(f.s, 'claude');
    expect(await readFile(join(workspace.cwd, 'shared.txt'), 'utf8')).toBe('current skipped file\n');
    expect(await readFile(join(workspace.cwd, 'assumed.txt'), 'utf8')).toBe('current assumed file\n');
    await expect(readFile(join(workspace.cwd, 'removed-addition.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await git(f.project, 'show', ':removed-addition.txt')).toBe('staged then removed');
  });
  it('respects staged untracking when the remaining local file is ignored', async () => {
    const f = await fixture();
    await git(f.project, 'rm', '--cached', 'shared.txt');
    await writeFile(join(f.project, '.gitignore'), 'shared.txt\n');
    await writeFile(join(f.project, 'shared.txt'), 'private local content after untracking\n');
    const index = await readFile(join(f.project, '.git', 'index'));
    const workspace = await f.manager.prepare(f.s, 'claude');
    await expect(readFile(join(workspace.cwd, 'shared.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(workspace.cwd, 'ls-files', 'shared.txt')).toBe('');
    expect(await readFile(join(workspace.cwd, '.gitignore'), 'utf8')).toBe('shared.txt\n');
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('private local content after untracking\n');
    expect(await git(f.project, 'ls-files', 'shared.txt')).toBe('');
  });
  it('rejects submodule snapshots without changing their local files or staging state', async () => {
    const f = await fixture();
    const child = join(f.root, 'child'); await mkdir(child);
    await git(child, 'init', '-b', 'main');
    await writeFile(join(child, 'tracked.txt'), 'committed child content\n');
    await git(child, 'add', '.'); await git(child, 'commit', '-m', 'Child baseline');
    await git(f.project, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module');
    await git(f.project, 'commit', '-am', 'Add submodule');
    const module = join(f.project, 'module');
    await writeFile(join(module, 'tracked.txt'), 'staged child content\n');
    await git(module, 'add', 'tracked.txt');
    await writeFile(join(module, 'tracked.txt'), 'current child content\n');
    await writeFile(join(module, 'untracked.txt'), 'untracked child content\n');
    const sourceIndex = await readFile(join(f.project, '.git', 'index'));
    const childIndexPath = await git(module, 'rev-parse', '--git-path', 'index');
    const childIndex = await readFile(childIndexPath);
    await expect(f.manager.prepare(f.s, 'claude')).rejects.toThrow(/submodule|nested Git/i);
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(sourceIndex);
    expect(await readFile(childIndexPath)).toEqual(childIndex);
    expect(await readFile(join(module, 'tracked.txt'), 'utf8')).toBe('current child content\n');
    expect(await readFile(join(module, 'untracked.txt'), 'utf8')).toBe('untracked child content\n');
    expect(await git(module, 'show', ':tracked.txt')).toBe('staged child content');
  });
  it('allows an empty deinitialized submodule but rejects local files inside it', async () => {
    const f = await fixture();
    const child = join(f.root, 'child'); await mkdir(child);
    await git(child, 'init', '-b', 'main');
    await writeFile(join(child, 'tracked.txt'), 'committed child content\n');
    await git(child, 'add', '.'); await git(child, 'commit', '-m', 'Child baseline');
    await git(f.project, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'module');
    await git(f.project, 'commit', '-am', 'Add submodule');
    await git(f.project, 'submodule', 'deinit', '--force', 'module');
    const first = await f.manager.prepare(f.s, 'claude');
    expect(first.writable).toBe(true);
    expect(await git(first.cwd, 'ls-files', '--stage', 'module')).toMatch(/^160000 /);
    // A separate session must capture the new filesystem rather than reuse the
    // successful baseline retained for the first session.
    f.s.id = createSession({ project: f.project, scope: 'build', brief: 'Review local files' }).id;
    await writeFile(join(f.project, 'module', 'local.txt'), 'local data in deinitialized submodule\n');
    const index = await readFile(join(f.project, '.git', 'index'));
    await expect(f.manager.prepare(f.s, 'claude')).rejects.toThrow(/submodule|nested Git/i);
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(f.project, 'module', 'local.txt'), 'utf8')).toBe('local data in deinitialized submodule\n');
  });
  it('excludes harness state inside the project from the shared snapshot', async () => {
    const f = await fixture();
    const stateDir = join(f.project, 'local-state');
    await mkdir(stateDir);
    await writeFile(join(stateDir, 'session.sqlite'), 'harness state must stay local');
    await writeFile(join(f.project, 'review.txt'), 'user changes to review');
    const manager = new GitWorkspaceManager(stateDir);
    const first = await manager.prepare(f.s, 'claude');
    const second = await manager.prepare(f.s, 'codex');
    for (const workspace of [first, second]) {
      expect(await readFile(join(workspace.cwd, 'review.txt'), 'utf8')).toBe('user changes to review');
      await expect(readFile(join(workspace.cwd, 'local-state', 'session.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await git(workspace.cwd, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'local-state')).toBe('');
    }
    expect(await readFile(join(stateDir, 'session.sqlite'), 'utf8')).toBe('harness state must stay local');
  });
  it('rejects unresolved source conflicts while preserving their index and worktree', async () => {
    const f = await fixture();
    await git(f.project, 'switch', '-c', 'other');
    await writeFile(join(f.project, 'shared.txt'), 'other branch\n');
    await git(f.project, 'commit', '-am', 'Other change');
    await git(f.project, 'switch', 'main');
    await writeFile(join(f.project, 'shared.txt'), 'main branch\n');
    await git(f.project, 'commit', '-am', 'Main change');
    await expect(git(f.project, 'merge', 'other')).rejects.toThrow();
    const index = await readFile(join(f.project, '.git', 'index'));
    const conflicted = await readFile(join(f.project, 'shared.txt'), 'utf8');
    const unmerged = await git(f.project, 'ls-files', '--unmerged');
    const mergeHead = await git(f.project, 'rev-parse', 'MERGE_HEAD');
    await expect(f.manager.prepare(f.s, 'claude')).rejects.toThrow(/conflict/i);
    expect(await readFile(join(f.project, '.git', 'index'))).toEqual(index);
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe(conflicted);
    expect(await git(f.project, 'ls-files', '--unmerged')).toBe(unmerged);
    expect(await git(f.project, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
  });
  it('commits independent work and merges into a separate integration branch', async () => {
    const f = await fixture();
    const [claude, codex] = await Promise.all([f.manager.prepare(f.s, 'claude'), f.manager.prepare(f.s, 'codex')]);
    await writeFile(join(claude.cwd, 'claude.txt'), 'Claude change');
    await writeFile(join(codex.cwd, 'codex.txt'), 'Codex change');
    f.s.completedTasks = { a: 'done', b: 'done' };
    expect(await f.manager.finalize(f.s, 'claude')).toMatch(/^[a-f0-9]{40,64}$/);
    expect(await f.manager.finalize(f.s, 'codex')).toMatch(/^[a-f0-9]{40,64}$/);
    const integrated = await f.manager.merge(f.s);
    expect(integrated.conflicts).toBe(false);
    expect(await readFile(join(integrated.path, 'claude.txt'), 'utf8')).toBe('Claude change');
    expect(await readFile(join(integrated.path, 'codex.txt'), 'utf8')).toBe('Codex change');
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
    expect(await git(f.project, 'branch', '--show-current')).toBe('main');
    expect(await git(f.project, 'status', '--porcelain')).toBe('');
    expect(await f.manager.prepare(f.s, 'claude')).toEqual({ cwd: f.project, writable: false });
    const restored = new GitWorkspaceManager(f.stateDir);
    expect(await restored.merge(f.s)).toEqual(integrated);
    expect(await restored.finalize(f.s, 'claude')).toBe(null);
  });
  it('brings committed dependencies into the receiving workspace', async () => {
    const f = await fixture([
      { id: 'a', owner: 'claude', description: 'API', dependsOn: [] },
      { id: 'b', owner: 'codex', description: 'Client', dependsOn: ['a'] },
    ]);
    expect((await f.manager.prepare(f.s, 'codex')).writable).toBe(false);
    const c = await f.manager.prepare(f.s, 'claude');
    await writeFile(join(c.cwd, 'api.txt'), 'API');
    f.s.completedTasks.a = 'done';
    await expect(f.manager.prepare(f.s, 'codex')).rejects.toThrow(/not been committed/);
    await f.manager.finalize(f.s, 'claude');
    const other = await f.manager.prepare(f.s, 'codex');
    expect(await readFile(join(other.cwd, 'api.txt'), 'utf8')).toBe('API');
    await writeFile(join(other.cwd, 'client.txt'), 'work in progress');
    expect(await f.manager.prepare(f.s, 'codex')).toEqual(other);
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  });
  it('preserves integration conflicts for agent resolution and verifies the reviewed revision', async () => {
    const f = await fixture();
    const c = await f.manager.prepare(f.s, 'claude'), d = await f.manager.prepare(f.s, 'codex');
    await writeFile(join(c.cwd, 'shared.txt'), 'Claude version\n');
    await writeFile(join(d.cwd, 'shared.txt'), 'Codex version\n');
    f.s.completedTasks = { a: 'done', b: 'done' };
    const claudeCommit = await f.manager.finalize(f.s, 'claude'), codexCommit = await f.manager.finalize(f.s, 'codex');
    const result = await f.manager.merge(f.s);
    expect(result.conflicts).toBe(true);
    expect(await git(result.path, 'diff', '--name-only', '--diff-filter=U')).toBe('shared.txt');
    await expect(f.manager.finishIntegration(f.s)).rejects.toThrow('conflict markers');
    f.s.integration = { status: 'resolving', path: result.path, owner: 'claude', reviewer: 'codex' };
    expect(await f.manager.prepareIntegration(f.s, 'claude')).toEqual({ cwd: result.path, writable: true });
    await expect(f.manager.prepareIntegration(f.s, 'codex')).rejects.toThrow('Wrong integration');
    await writeFile(join(result.path, 'shared.txt'), 'Combined behavior\n');
    const combined = await new GitWorkspaceManager(f.stateDir).finishIntegration(f.s);
    expect(combined.conflicts).toBe(false);
    expect(await f.manager.verifyIntegration(f.s, combined.revision!)).toBe(true);
    f.s.integration.status = 'peer_review';
    expect(await f.manager.prepareIntegration(f.s, 'codex')).toEqual({ cwd: result.path, writable: false });
    await writeFile(join(result.path, 'shared.txt'), 'Changed during review\n');
    expect(await f.manager.verifyIntegration(f.s, combined.revision!)).toBe(false);
    expect(await git(c.cwd, 'rev-parse', 'HEAD')).toBe(claudeCommit);
    expect(await git(d.cwd, 'rev-parse', 'HEAD')).toBe(codexCommit);
    expect(await readFile(join(f.project, 'shared.txt'), 'utf8')).toBe('original\n');
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  });
  it('does not commit unfinished task changes', async () => {
    const f = await fixture();
    const w = await f.manager.prepare(f.s, 'claude');
    await writeFile(join(w.cwd, 'unfinished.txt'), 'unfinished');
    expect(await f.manager.finalize(f.s, 'claude')).toBe(null);
    expect(await git(w.cwd, 'rev-parse', 'HEAD')).toBe(f.base);
  });
  it('commits edits from a repeated completion after an interrupted finalization', async () => {
    const f = await fixture();
    const w = await f.manager.prepare(f.s, 'claude');
    await writeFile(join(w.cwd, 'first.txt'), 'first attempt');
    f.s.completedTasks = { a: 'done' };
    const first = await f.manager.finalize(f.s, 'claude');
    expect(first).toMatch(/^[a-f0-9]{40,64}$/);
    // The controller never recorded the completion, so the agent completed the task again with more edits.
    await writeFile(join(w.cwd, 'second.txt'), 'second attempt');
    const second = await f.manager.finalize(f.s, 'claude');
    expect(second).toMatch(/^[a-f0-9]{40,64}$/);
    expect(second).not.toBe(first);
    expect(await git(w.cwd, 'status', '--porcelain')).toBe('');
    expect(await f.manager.finalize(f.s, 'claude')).toBe(null);
    f.s.completedTasks = { a: 'done', b: 'done' };
    await f.manager.finalize(f.s, 'codex');
    const integrated = await f.manager.merge(f.s);
    expect(await readFile(join(integrated.path, 'second.txt'), 'utf8')).toBe('second attempt');
  });
  it('integrates finalized snapshots instead of later unfinished branch commits', async () => {
    const f = await fixture();
    const w = await f.manager.prepare(f.s, 'claude');
    await writeFile(join(w.cwd, 'completed.txt'), 'finished');
    f.s.completedTasks.a = 'done';
    await f.manager.finalize(f.s, 'claude');
    await writeFile(join(w.cwd, 'unfinished.txt'), 'not finalized');
    await git(w.cwd, 'add', '.'); await git(w.cwd, 'commit', '-m', 'Native agent unfinished changes');
    const integrated = await f.manager.merge(f.s);
    expect(integrated.conflicts).toBe(false);
    expect(await readFile(join(integrated.path, 'completed.txt'), 'utf8')).toBe('finished');
    await expect(readFile(join(integrated.path, 'unfinished.txt'))).rejects.toThrow();
  });
  it('pauses dependency synchronization on conflict without overwriting work', async () => {
    const f = await fixture([
      { id: 'a', owner: 'claude', description: 'API', dependsOn: [] },
      { id: 'b', owner: 'codex', description: 'Independent change', dependsOn: [] },
      { id: 'c', owner: 'codex', description: 'Dependent integration', dependsOn: ['a'] },
    ]);
    const c = await f.manager.prepare(f.s, 'claude'), d = await f.manager.prepare(f.s, 'codex');
    await writeFile(join(c.cwd, 'shared.txt'), 'Claude\n');
    await writeFile(join(d.cwd, 'shared.txt'), 'Codex\n');
    f.s.completedTasks = { a: 'done', b: 'done' };
    await f.manager.finalize(f.s, 'claude');
    const before = await f.manager.finalize(f.s, 'codex');
    await expect(f.manager.prepare(f.s, 'codex')).rejects.toThrow(/conflict.*pause/);
    expect(await git(d.cwd, 'rev-parse', 'HEAD')).toBe(before);
    expect(await git(d.cwd, 'status', '--porcelain')).toBe('');
    expect(await readFile(join(d.cwd, 'shared.txt'), 'utf8')).toBe('Codex\n');
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  });
  it('recovers a worktree created before its metadata was saved', async () => {
    const f = await fixture();
    const created = await f.manager.prepare(f.s, 'claude');
    const metadataPath = join(f.stateDir, 'worktrees', f.s.id, 'workspace.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    delete metadata.agents.claude;
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restarted = new GitWorkspaceManager(f.stateDir);
    expect(await restarted.prepare(f.s, 'claude')).toEqual(created);
    expect(JSON.parse(await readFile(metadataPath, 'utf8')).agents.claude.path).toBe(created.cwd);
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  });
  it('preserves an unmatched orphan worktree rather than overwriting it', async () => {
    const f = await fixture();
    const created = await f.manager.prepare(f.s, 'claude');
    await writeFile(join(created.cwd, 'keep.txt'), 'preserve my changes');
    const metadataPath = join(f.stateDir, 'worktrees', f.s.id, 'workspace.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    delete metadata.agents.claude;
    await writeFile(metadataPath, JSON.stringify(metadata));
    const restarted = new GitWorkspaceManager(f.stateDir);
    await expect(restarted.prepare(f.s, 'claude')).rejects.toThrow(/safely reconciled.*preserved/);
    expect(await readFile(join(created.cwd, 'keep.txt'), 'utf8')).toBe('preserve my changes');
    expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  });
});

it('isolates same-provider instances and integrates their dependency commits', async () => {
  const f = await fixture([
    { id: 'a', owner: 'agent-1', description: 'API', dependsOn: [] },
    { id: 'b', owner: 'agent-2', description: 'Client', dependsOn: ['a'] },
  ]);
  f.s.interaction = 'collaborate';
  f.s.agents = [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'codex' }];
  const first = await f.manager.prepare(f.s, 'agent-1');
  await writeFile(join(first.cwd, 'api.txt'), 'API');
  f.s.completedTasks.a = 'done';
  await f.manager.finalize(f.s, 'agent-1');
  const second = await f.manager.prepare(f.s, 'agent-2');
  expect(second.cwd).not.toBe(first.cwd);
  expect(await readFile(join(second.cwd, 'api.txt'), 'utf8')).toBe('API');
  expect(await git(first.cwd, 'branch', '--show-current')).toBe(`duet/${f.s.id}/agent-1`);
  expect(await git(second.cwd, 'branch', '--show-current')).toBe(`duet/${f.s.id}/agent-2`);
  await writeFile(join(second.cwd, 'client.txt'), 'Client');
  f.s.completedTasks.b = 'done';
  await f.manager.finalize(f.s, 'agent-2');
  const integration = await new GitWorkspaceManager(f.stateDir).merge(f.s);
  expect(integration.conflicts).toBe(false);
  expect(await readFile(join(integration.path, 'client.txt'), 'utf8')).toBe('Client');
  expect(await git(f.project, 'rev-parse', 'HEAD')).toBe(f.base);
  await expect(f.manager.prepare(f.s, 'codex')).rejects.toThrow('Unknown agent');
});
