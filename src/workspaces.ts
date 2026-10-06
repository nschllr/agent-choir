import { agentIds, validAgentId } from './agents.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canImplement } from './engine.js';
import { type AgentId, type Session, type WorkspaceAccess, type WorkspaceManager } from './types.js';

const exec = promisify(execFile);
interface BranchState { path: string; branch: string; completed: string[]; finalizedCommit?: string; }
interface WorkspaceState { project: string; base: string; agents: Partial<Record<AgentId, BranchState>>; integration?: BranchState; }
const git = async (cwd: string, ...args: string[]): Promise<string> => {
  try {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
    const result = await exec('git', ['-c', 'user.name=Agent Duet', '-c', 'user.email=agent-duet@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, maxBuffer: 8 * 1024 * 1024, env });
    return result.stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new Error(`Git ${args[0]} failed: ${e.stderr?.trim() || e.message}`, { cause: error });
  }
};

/** Worktrees are retained for inspection. No operation checks out or commits on the user's branch. */
export class GitWorkspaceManager implements WorkspaceManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly stateDir: string) {}
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
  private directory(s: Session): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(s.id)) throw new Error('Invalid session identifier');
    return join(resolve(this.stateDir), 'worktrees', s.id);
  }
  private async load(s: Session): Promise<WorkspaceState | null> {
    try {
      const state = JSON.parse(await readFile(join(this.directory(s), 'workspace.json'), 'utf8')) as WorkspaceState;
      if (state.project !== await realpath(s.project) || typeof state.base !== 'string' || !/^[0-9a-f]{40,64}$/.test(state.base)) throw new Error('Workspace metadata does not match this project');
      if (!state.agents || typeof state.agents !== 'object' || Array.isArray(state.agents) || Object.keys(state.agents).some(a => !agentIds(s).includes(a))) throw new Error('Invalid workspace metadata');
      for (const name of [...agentIds(s), 'integration']) {
        const branch = name === 'integration' ? state.integration : state.agents[name];
        if (!branch) continue;
        if (branch.path !== join(this.directory(s), name) || branch.branch !== `duet/${s.id}/${name}` || !Array.isArray(branch.completed) || branch.completed.some(id => typeof id !== 'string') || (branch.finalizedCommit !== undefined && !/^[0-9a-f]{40,64}$/.test(branch.finalizedCommit))) throw new Error('Invalid workspace branch metadata');
      }
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private async save(s: Session, state: WorkspaceState): Promise<void> {
    const dir = this.directory(s);
    await mkdir(dir, { recursive: true });
    const temporary = join(dir, 'workspace.json.tmp');
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, join(dir, 'workspace.json'));
  }
  private async initial(s: Session): Promise<WorkspaceState> {
    const previous = await this.load(s);
    if (previous) return previous;
    const project = await realpath(s.project);
    let base: string;
    try {
      const top = await git(project, 'rev-parse', '--show-toplevel');
      if (await realpath(top) !== project) throw new Error('Choose the repository root as the project');
      base = await git(project, 'rev-parse', '--verify', 'HEAD');
    } catch (error) { throw new Error('Build requires a Git repository root with an existing HEAD commit', { cause: error }); }
    if (await git(project, 'status', '--porcelain', '--untracked-files=all')) throw new Error('Build requires a clean project repository; commit or stash your existing changes first');
    const state: WorkspaceState = { project, base, agents: {} };
    await this.save(s, state);
    return state;
  }
  private async branch(s: Session, state: WorkspaceState, name: AgentId | 'integration'): Promise<BranchState> {
    if (name !== 'integration' && (!validAgentId(name) || !agentIds(s).includes(name))) throw new Error('Unknown agent');
    const existing = name === 'integration' ? state.integration : state.agents[name];
    if (existing) {
      if (await realpath(existing.path) === state.project) throw new Error('An agent workspace cannot be the original repository');
      const current = await git(existing.path, 'symbolic-ref', '--short', 'HEAD');
      if (current !== existing.branch) throw new Error(`Workspace branch changed unexpectedly: ${existing.path}`);
      return existing;
    }
    const path = join(this.directory(s), name), branch = `duet/${s.id}/${name}`;
    // Git creation and metadata replacement are separate durable operations. Reconcile
    // a fully created worktree after a crash between them instead of retrying -b.
    const fields = (await git(state.project, 'worktree', 'list', '--porcelain', '-z')).split('\0');
    const registered: { path: string; branch?: string; head?: string }[] = [];
    let record: { path: string; branch?: string; head?: string } | undefined;
    for (const field of fields) {
      if (field.startsWith('worktree ')) { record = { path: field.slice(9) }; registered.push(record); }
      else if (record && field.startsWith('branch ')) record.branch = field.slice(7);
      else if (record && field.startsWith('HEAD ')) record.head = field.slice(5);
    }
    const candidate = registered.find(w => resolve(w.path) === path);
    let pathExists = false, branchExists = false;
    try { await lstat(path); pathExists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await git(state.project, 'show-ref', '--verify', `refs/heads/${branch}`); branchExists = true; } catch { /* Absent ref is normal for a fresh workspace. */ }
    if (candidate || pathExists || branchExists) {
      const conflict = () => new Error(`Existing workspace cannot be safely reconciled; preserved for inspection: ${path}`);
      if (!candidate || !pathExists || !branchExists || candidate.branch !== `refs/heads/${branch}` || candidate.head !== state.base) throw conflict();
      const sourceCommon = await git(state.project, 'rev-parse', '--git-common-dir');
      const targetCommon = await git(path, 'rev-parse', '--git-common-dir');
      if (await realpath(resolve(state.project, sourceCommon)) !== await realpath(resolve(path, targetCommon)) ||
          await realpath(path) === state.project ||
          await realpath(await git(path, 'rev-parse', '--show-toplevel')) !== await realpath(path) ||
          await git(path, 'symbolic-ref', '--short', 'HEAD') !== branch ||
          await git(path, 'rev-parse', 'HEAD') !== state.base ||
          await git(path, 'status', '--porcelain', '--untracked-files=all')) throw conflict();
    } else {
      await git(state.project, 'worktree', 'add', '-b', branch, path, state.base);
    }
    const created = { path, branch, completed: [] };
    if (name === 'integration') state.integration = created; else state.agents[name] = created;
    await this.save(s, state);
    return created;
  }
  private async mergeBranch(target: BranchState, source: BranchState): Promise<boolean> {
    // Integrate a finalized snapshot, never a live branch that may contain unfinished work.
    const commit = source.finalizedCommit;
    if (!commit) throw new Error('Source workspace has no finalized commit');
    try { await git(target.path, 'merge-base', '--is-ancestor', commit, 'HEAD'); return true; } catch { /* New dependency commits need integration. */ }
    if (await git(target.path, 'status', '--porcelain', '--untracked-files=all')) throw new Error(`Workspace has uncommitted changes; cannot synchronize: ${target.path}`);
    try { await git(target.path, 'merge', '--no-edit', commit); return true; }
    catch (error) {
      // Abort only an actual merge conflict. Preserve every branch and worktree.
      try { await git(target.path, 'rev-parse', '--verify', 'MERGE_HEAD'); }
      catch { throw error; }
      await git(target.path, 'merge', '--abort');
      return false;
    }
  }
  prepare(s: Session, agent: AgentId): Promise<WorkspaceAccess> {
    return this.serial(async () => {
      if (!validAgentId(agent) || !agentIds(s).includes(agent)) throw new Error('Unknown agent');
      const tasks = s.decisions.find(d => d.kind === 'plan')?.tasks ?? [];
      const eligible = tasks.filter(t => t.owner === agent && !Object.hasOwn(s.completedTasks, t.id) && t.dependsOn.every(id => Object.hasOwn(s.completedTasks, id)));
      if (!canImplement(s) || !eligible.length) return { cwd: s.project, writable: false };
      const state = await this.initial(s), target = await this.branch(s, state, agent);
      const dependencies = new Set(eligible.flatMap(t => t.dependsOn));
      for (const id of dependencies) {
        const task = tasks.find(t => t.id === id)!;
        if (task.owner === agent) {
          if (!target.completed.includes(id)) throw new Error(`Dependency ${id} has not been committed`);
          continue;
        }
        const source = state.agents[task.owner];
        if (!source?.completed.includes(id)) throw new Error(`Dependency ${id} has not been committed by ${task.owner}`);
        if (!await this.mergeBranch(target, source)) throw new Error(`Dependency integration conflict in ${target.path}; session must pause for user resolution`);
      }
      return { cwd: target.path, writable: true };
    });
  }
  finalize(s: Session, agent: AgentId): Promise<string | null> {
    return this.serial(async () => {
      if (!validAgentId(agent) || !agentIds(s).includes(agent)) throw new Error('Unknown agent');
      const state = await this.load(s), target = state?.agents[agent];
      if (!state || !target) return null;
      await this.branch(s, state, agent);
      const completed = (s.decisions.find(d => d.kind === 'plan')?.tasks ?? []).filter(t => t.owner === agent && Object.hasOwn(s.completedTasks, t.id) && !target.completed.includes(t.id));
      if (!completed.length) return null;
      let commit: string | null = null;
      if (await git(target.path, 'status', '--porcelain', '--untracked-files=all')) {
        await git(target.path, 'add', '--all');
        await git(target.path, 'commit', '-m', `Complete ${agent} tasks: ${completed.map(t => t.id).join(', ')}`);
      }
      const head = await git(target.path, 'rev-parse', 'HEAD');
      if (head !== (target.finalizedCommit ?? state.base)) commit = head;
      target.finalizedCommit = head;
      target.completed.push(...completed.map(t => t.id));
      await this.save(s, state);
      return commit;
    });
  }
  merge(s: Session): Promise<{ path: string; conflicts: boolean }> {
    return this.serial(async () => {
      const state = await this.load(s);
      if (!state) throw new Error('No build workspaces exist for this session');
      const target = await this.branch(s, state, 'integration');
      for (const agent of agentIds(s)) {
        const source = state.agents[agent];
        if (source?.completed.length && !await this.mergeBranch(target, source)) return { path: target.path, conflicts: true };
      }
      return { path: target.path, conflicts: false };
    });
  }
}
