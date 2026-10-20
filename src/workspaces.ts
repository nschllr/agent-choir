import { agentIds, isCollaborating, validAgentId } from './agents.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { canImplement } from './engine.js';
import { type AgentId, type Session, type WorkspaceAccess, type WorkspaceManager, type IntegrationCandidate, type AdoptionResult, type CleanupResult } from './types.js';

const exec = promisify(execFile);
interface BranchState { path: string; branch: string; completed: string[]; finalizedCommit?: string; }
interface WorkspaceState { project: string; base: string; agents: Partial<Record<AgentId, BranchState>>; integration?: BranchState; }
const runGit = async (cwd: string, args: string[], options: { index?: string; raw?: boolean } = {}): Promise<string> => {
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete (env as NodeJS.ProcessEnv)[key];
    if (options.index) env.GIT_INDEX_FILE = options.index;
    const result = await exec('git', ['-c', 'user.name=Agent Duet', '-c', 'user.email=agent-duet@localhost', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', ...args], { cwd, maxBuffer: 8 * 1024 * 1024, env });
    return options.raw ? result.stdout : result.stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    throw new Error(`Git ${args[0]} failed: ${e.stderr?.trim() || e.message}`, { cause: error });
  }
};
const git = (cwd: string, ...args: string[]): Promise<string> => runGit(cwd, args);

function inside(parent: string, path: string): string | undefined {
  const name = relative(parent, path);
  return name !== '..' && !name.startsWith(`..${sep}`) && !name.startsWith(sep) ? name : undefined;
}

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
  private async snapshot(s: Session, project: string, head: string): Promise<string> {
    // Keep the baseline reachable even if the process dies before workspace.json
    // is saved. A retry must not capture a different version of the user's files.
    const ref = `refs/duet/${s.id}/base`;
    let previous: string | undefined;
    try { previous = await git(project, 'rev-parse', '--verify', `${ref}^{commit}`); } catch { /* First preparation. */ }
    if (previous) return previous;
    if (await git(project, 'ls-files', '--unmerged')) throw new Error('Resolve existing Git merge conflicts before starting collaborative implementation');

    await mkdir(this.stateDir, { recursive: true });
    const exclusions = [...new Set([resolve(this.stateDir), await realpath(this.stateDir)]
      .map(path => inside(project, path)).filter((path): path is string => path !== undefined))];
    if (exclusions.includes('')) throw new Error('Choose a state directory separate from the project root');
    const excluded = (path: string) => exclusions.some(name => path === name || path.startsWith(`${name}/`));
    const temporary = await mkdtemp(join(await realpath(this.stateDir), 'snapshot-'));
    const index = join(temporary, 'index');
    const indexed = (...args: string[]) => runGit(project, args, { index });
    try {
      // A fresh index avoids copying skip-worktree/assume-unchanged flags or a
      // split index. No command stages, stashes, or checks out the original tree.
      await indexed('read-tree', head);
      const original = new Set((await runGit(project, ['ls-files', '--cached', '-z'], { raw: true })).split('\0').filter(Boolean));
      const baseline = new Set((await runGit(project, ['ls-files', '--cached', '-z'], { index, raw: true })).split('\0').filter(Boolean));
      // Respect files removed from tracking. In particular, a now-ignored local
      // file must not be reintroduced just because it existed in HEAD.
      const removed = [...baseline].filter(path => !original.has(path));
      if (removed.length) {
        const paths = join(temporary, 'removed-paths');
        await writeFile(paths, `${removed.map(path => `:(literal)${path}`).join('\0')}\0`, { mode: 0o600 });
        await indexed('rm', '--cached', `--pathspec-from-file=${paths}`, '--pathspec-file-nul');
      }
      const additions: string[] = [];
      for (const path of original) {
        if (baseline.has(path) || excluded(path)) continue;
        try {
          const stat = await lstat(join(project, path));
          if (stat.isFile() || stat.isSymbolicLink()) additions.push(`:(literal)${path}`);
        } catch (error) {
          if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
      // Explicitly staged new files can be ignored by .gitignore. Include their
      // current contents while ordinary untracked ignored files remain excluded.
      if (additions.length) {
        const paths = join(temporary, 'tracked-paths');
        await writeFile(paths, `${additions.join('\0')}\0`, { mode: 0o600 });
        await indexed('add', '--force', `--pathspec-from-file=${paths}`, '--pathspec-file-nul');
      }
      await indexed('add', '--all', '--', '.', ...exclusions.map(name => `:(exclude,literal)${name}`));
      for (const name of exclusions) await indexed('rm', '-r', '--cached', '--ignore-unmatch', '--', `:(literal)${name}`);
      // Gitlinks record commit IDs, not nested working files. Inspect the actual
      // candidate so this also catches newly added embedded repositories.
      const entries = (await runGit(project, ['ls-files', '--stage', '-z'], { index, raw: true })).split('\0');
      for (const entry of entries.filter(entry => entry.startsWith('160000 '))) {
        const path = join(project, entry.slice(entry.indexOf('\t') + 1));
        try {
          if (!(await lstat(path)).isDirectory()) continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        // Only empty uninitialized submodules can be represented by their saved
        // gitlink without silently losing local files from the snapshot.
        if (await realpath(await git(path, 'rev-parse', '--show-toplevel')) !== await realpath(path)) {
          if ((await readdir(path)).length) throw new Error('An uninitialized submodule contains local files; initialize it and commit those changes before starting collaborative implementation');
          continue;
        }
        if (await git(path, 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none')) {
          throw new Error('Commit changes inside submodules or nested Git repositories before starting collaborative implementation; a Git snapshot cannot include their uncommitted files');
        }
      }
      const tree = await indexed('write-tree');
      const base = tree === await git(project, 'rev-parse', `${head}^{tree}`) ? head
        : await git(project, 'commit-tree', tree, '-p', head, '-m', `Agent Duet starting snapshot for ${s.id}`);
      await git(project, 'update-ref', ref, base, '0'.repeat(head.length));
      return base;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
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
    base = await this.snapshot(s, project, base);
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
  private async mergeBranch(target: BranchState, source: BranchState, preserveConflict = false): Promise<boolean> {
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
      if (!preserveConflict) await git(target.path, 'merge', '--abort');
      return false;
    }
  }
  prepare(s: Session, agent: AgentId): Promise<WorkspaceAccess> {
    return this.serial(async () => {
      if (!validAgentId(agent) || !agentIds(s).includes(agent)) throw new Error('Unknown agent');
      if (!isCollaborating(s)) return { cwd: s.project, writable: s.scope === 'build' && !s.demo };
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
      // A task recorded here but interrupted before the session accepted it is
      // completed again later; that retry's edits must still reach the snapshot.
      if (!completed.length && !target.completed.length) return null;
      let commit: string | null = null;
      if (await git(target.path, 'status', '--porcelain', '--untracked-files=all')) {
        await git(target.path, 'add', '--all');
        await git(target.path, 'commit', '-m', `Complete ${agent} tasks: ${(completed.length ? completed.map(t => t.id) : target.completed).join(', ')}`);
      }
      const head = await git(target.path, 'rev-parse', 'HEAD');
      if (head !== (target.finalizedCommit ?? state.base)) commit = head;
      target.finalizedCommit = head;
      target.completed.push(...completed.map(t => t.id));
      await this.save(s, state);
      return commit;
    });
  }
  private async hasMerge(path: string): Promise<boolean> {
    try { await git(path, 'rev-parse', '--verify', 'MERGE_HEAD'); return true; } catch { return false; }
  }
  private async mergeSources(s: Session, state: WorkspaceState, target: BranchState): Promise<IntegrationCandidate> {
    if (await this.hasMerge(target.path)) return { path: target.path, conflicts: true };
    for (const agent of agentIds(s)) {
      const source = state.agents[agent];
      if (source?.completed.length && !await this.mergeBranch(target, source, true)) return { path: target.path, conflicts: true };
    }
    return { path: target.path, conflicts: false, revision: await git(target.path, 'rev-parse', 'HEAD') };
  }
  merge(s: Session): Promise<IntegrationCandidate> {
    return this.serial(async () => {
      const state = await this.load(s);
      if (!state) throw new Error('No build workspaces exist for this session');
      const target = await this.branch(s, state, 'integration');
      return this.mergeSources(s, state, target);
    });
  }
  prepareIntegration(s: Session, agent: AgentId): Promise<WorkspaceAccess> {
    return this.serial(async () => {
      const i = s.integration;
      const expected = i?.status === 'resolving' ? i.owner : i?.reviewer;
      if (!i || agent !== expected) throw new Error('Wrong integration participant');
      const state = await this.load(s);
      if (!state?.integration) throw new Error('No integration workspace exists');
      const target = await this.branch(s, state, 'integration');
      return { cwd: target.path, writable: i.status === 'resolving' && s.scope === 'build' && !s.demo };
    });
  }
  finishIntegration(s: Session): Promise<IntegrationCandidate> {
    return this.serial(async () => {
      const state = await this.load(s);
      if (!state?.integration) throw new Error('No integration workspace exists');
      const target = await this.branch(s, state, 'integration');
      try { await git(target.path, 'diff', '--check'); }
      catch (error) { throw new Error('Integration still has conflict markers or whitespace errors', { cause: error }); }
      await git(target.path, 'diff', '--cached', '--check');
      if (await this.hasMerge(target.path) || await git(target.path, 'status', '--porcelain', '--untracked-files=all')) {
        await git(target.path, 'add', '--all');
        if (await git(target.path, 'diff', '--name-only', '--diff-filter=U')) throw new Error('Integration still has unresolved merge conflicts');
        await git(target.path, 'diff', '--cached', '--check');
        await git(target.path, 'commit', '-m', 'Resolve and validate integrated agent work');
      }
      // More finalized branches can remain after the first conflict was resolved.
      const validatedHead = await git(target.path, 'rev-parse', 'HEAD');
      const merged = await this.mergeSources(s, state, target);
      return { ...merged, needsValidation: !merged.conflicts && merged.revision !== validatedHead };
    });
  }
  /** Apply the accepted candidate to the original checkout as uncommitted changes. HEAD, the
   * branch and the index stay untouched; the user reviews and commits with ordinary Git. */
  adopt(s: Session): Promise<AdoptionResult> {
    return this.serial(async () => {
      const state = await this.load(s);
      if (!state?.integration) throw new Error('No integration candidate exists for this session');
      const target = await this.branch(s, state, 'integration');
      if (await this.hasMerge(target.path) || await git(target.path, 'status', '--porcelain', '--untracked-files=all')) throw new Error('The integration worktree has unfinished changes; finish or discard them before adopting');
      const revision = await git(target.path, 'rev-parse', 'HEAD');
      if (s.integration?.revision && s.integration.revision !== revision) throw new Error('The integration worktree no longer matches the reviewed candidate revision');
      if (await git(state.project, 'ls-files', '--unmerged')) throw new Error('Resolve existing merge conflicts in the original checkout before adopting');
      const files = (await runGit(state.project, ['diff', '--name-only', '-z', state.base, revision], { raw: true })).split('\0').filter(Boolean);
      if (!files.length) return { revision, files, branch: target.branch };
      const temporary = await mkdtemp(join(await realpath(this.stateDir), 'adopt-'));
      try {
        const patch = join(temporary, 'candidate.patch');
        await git(state.project, 'diff', '--binary', '--full-index', `--output=${patch}`, state.base, revision);
        // Preimages are checked against the working tree, so a file edited since the
        // snapshot refuses the whole patch instead of mixing the user's and agents' changes.
        try { await git(state.project, 'apply', '--check', '--whitespace=nowarn', patch); }
        catch (error) { throw new Error(`The candidate does not apply cleanly; files changed in the original checkout since the snapshot. Commit or stash those changes and retry, or merge branch ${target.branch} manually. Nothing was changed.`, { cause: error }); }
        await git(state.project, 'apply', '--whitespace=nowarn', patch);
      } finally { await rm(temporary, { recursive: true, force: true }); }
      return { revision, files, branch: target.branch };
    });
  }
  /** Remove this session's worktrees, branches and snapshot ref. Unfinalized worktree edits are discarded. */
  clean(s: Session): Promise<CleanupResult> {
    return this.serial(async () => {
      const directory = this.directory(s);
      const removed: string[] = [], warnings: string[] = [];
      let project: string | undefined;
      try { project = (await this.load(s))?.project; }
      catch (error) { warnings.push(`Workspace metadata was not usable: ${error instanceof Error ? error.message : String(error)}`); }
      project ??= await realpath(s.project).catch(() => undefined);
      let repository = false;
      if (project) { try { repository = await realpath(await git(project, 'rev-parse', '--show-toplevel')) === project; } catch { /* Not a repository any more. */ } }
      if (repository && project) {
        for (const name of [...agentIds(s), 'integration']) {
          const path = join(directory, name), branch = `duet/${s.id}/${name}`;
          const registered = (await git(project, 'worktree', 'list', '--porcelain', '-z')).split('\0').some(field => field.startsWith('worktree ') && resolve(field.slice(9)) === path);
          if (registered) {
            try { await git(project, 'worktree', 'remove', '--force', path); removed.push(path); }
            catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
          }
          let exists = true;
          try { await git(project, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); } catch { exists = false; }
          if (exists) {
            try { await git(project, 'branch', '-D', branch); removed.push(branch); }
            catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
          }
        }
        const ref = `refs/duet/${s.id}/base`;
        try { await git(project, 'rev-parse', '--verify', '--quiet', ref); await git(project, 'update-ref', '-d', ref); removed.push(ref); } catch { /* Absent. */ }
        try { await git(project, 'worktree', 'prune'); } catch (error) { warnings.push(error instanceof Error ? error.message : String(error)); }
      } else warnings.push('The original repository is unavailable; its branches and refs were not removed');
      await rm(directory, { recursive: true, force: true });
      return { removed, warnings };
    });
  }
  verifyIntegration(s: Session, revision: string): Promise<boolean> {
    return this.serial(async () => {
      const state = await this.load(s);
      if (!state?.integration || !/^[0-9a-f]{40,64}$/.test(revision)) return false;
      const target = await this.branch(s, state, 'integration');
      if (await git(target.path, 'rev-parse', 'HEAD') !== revision || await this.hasMerge(target.path)
        || await git(target.path, 'status', '--porcelain', '--untracked-files=all')) return false;
      try { await git(target.path, 'diff', '--check', state.base, revision); } catch { return false; }
      const tasks = s.decisions.find(d => d.kind === 'plan')?.tasks ?? [];
      for (const task of tasks) {
        const source = state.agents[task.owner];
        if (!source?.finalizedCommit || !source.completed.includes(task.id) || !Object.hasOwn(s.completedTasks, task.id)) return false;
        try { await git(target.path, 'merge-base', '--is-ancestor', source.finalizedCommit, revision); } catch { return false; }
      }
      return true;
    });
  }
}
