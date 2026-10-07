import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { connectController } from '../src/background.js';
import { SessionStore } from '../src/store.js';
import { createSession } from '../src/engine.js';
import type { UIController } from '../src/types.js';

const execute = promisify(execFile);
const executable = resolve('dist/cli.js');
const hasPythonPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { timeout: 3000 }).status === 0;
async function cli(args: string[]) {
  return execute(process.execPath, [executable, ...args], { timeout: 12_000, maxBuffer: 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } });
}
async function attach(directory: string, id: string) {
  const deadline = Date.now() + 4000;
  while (true) {
    try { return await connectController(directory, id); }
    catch (error) { if (Date.now() >= deadline) throw error; await sleep(50); }
  }
}
async function complete(controller: UIController) {
  if (controller.getView().session.status === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('Detached demonstration did not complete')); }, 8000);
    const inspect = () => {
      const session = controller.getView().session;
      if (session.status === 'complete' || session.status === 'error') {
        clearTimeout(timer); unsubscribe();
        if (session.status === 'error') reject(new Error(session.error)); else resolve();
      }
    };
    unsubscribe = controller.subscribe(inspect); inspect();
  });
}
async function stopFixtureWorkers(directory: string) {
  // Only PIDs recorded under this test's uniquely created state directory are touched.
  const lockDirectory = join(directory, 'locks');
  for (const name of await readdir(lockDirectory).catch(() => [])) {
    if (!name.endsWith('.lock')) continue;
    const lock = JSON.parse(await readFile(join(lockDirectory, name), 'utf8')) as { pid: number };
    if (!Number.isInteger(lock.pid) || lock.pid <= 0 || lock.pid === process.pid) throw new Error('Unexpected fixture worker PID');
    try { process.kill(lock.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error; }
    const deadline = Date.now() + 4000;
    while (true) {
      try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
      // A zombie has exited, even when the host's process supervisor has not reaped it yet.
      const status = await readFile(`/proc/${lock.pid}/status`, 'utf8').catch(() => '');
      if (/^State:\s+Z/m.test(status)) break;
      if (Date.now() >= deadline) { process.kill(lock.pid, 'SIGKILL'); throw new Error('Fixture worker did not exit after SIGTERM'); }
      await sleep(50);
    }
  }
}

describe('built CLI offline smoke', () => {
  it('answers a greeting only in the selected pane and collaborates only when explicitly requested', async () => {
    const directory = await mkdtemp('/tmp/duet-cli-direct-');
    try {
      const args = ['--demo', '--agent', 'codex', '--peer', 'claude', '--headless', '--json', '--state-dir', directory];
      const direct = JSON.parse((await cli([...args, 'hi'])).stdout);
      expect(direct).toMatchObject({ interaction: 'chat', turns: 1, pendingRecipients: [], status: 'paused' });
      expect(Object.keys(direct.providerSessions)).toEqual(['agent-1']);
      expect(direct.messages.filter((message: any) => message.from === 'agent-1')).toEqual([expect.objectContaining({ to: 'agent-1' })]);
      expect(direct.messages.some((message: any) => message.from === 'agent-2')).toBe(false);
      const shared = JSON.parse((await cli([...args, '--collaborate', 'Compare two timer designs together'])).stdout);
      expect(shared).toMatchObject({ interaction: 'collaborate', status: 'complete' });
      expect(Object.keys(shared.providerSessions).sort()).toEqual(['agent-1', 'agent-2']);
      expect(shared.turns).toBeGreaterThan(1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);
  it.skipIf(!hasPythonPty).each(['interactive', 'headless', 'empty', 'read-only'] as const)('opens directly into %s execution', async mode => {
    const directory = await mkdtemp('/tmp/duet-cli-start-');
    try {
      const args = mode === 'headless' ? ['--demo', '--headless', '--json'] : mode === 'interactive' ? ['--demo', '--agent', 'codex'] : mode === 'read-only' ? ['--read-only'] : [];
      // Authentication guards ensure even a startup regression cannot call a real provider.
      const output = await execute('python3', [resolve('tests/fixtures/interactive.py'), process.execPath, executable, JSON.stringify(['--state-dir', directory, ...args]), mode], { timeout: 20_000, maxBuffer: 1024 * 1024, env: { ...process.env, OPENAI_API_KEY: 'offline-test-guard', ANTHROPIC_API_KEY: 'offline-test-guard' } });
      expect(output.stdout).toContain('exited normally');
      if (mode !== 'headless') {
        const store = new SessionStore(directory);
        try {
          const saved = store.load(store.list()[0]!.id)!;
          expect(saved.agents).toEqual([{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'codex' }]);
          if (mode === 'empty' || mode === 'read-only') expect(saved).toMatchObject({ scope: mode === 'empty' ? 'build' : 'discuss', turns: 0, messages: [], activities: [], providerSessions: {} });
          else expect(Object.keys(saved.providerSessions).sort()).toEqual(['agent-1', 'agent-2']);
        } finally { store.close(); }
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 25_000);

  it('rejects conflicting permissions and preserves legacy read-only sessions on resume', async () => {
    const directory = await mkdtemp('/tmp/duet-cli-permissions-');
    try {
      expect((await cli(['--help'])).stdout).toContain('--read-only');
      await expect(cli(['--read-only', '--scope', 'build', '--state-dir', directory])).rejects.toMatchObject({ stderr: expect.stringContaining('cannot be combined') });
      const session = createSession({ project: '/tmp', brief: 'Earlier recommendation', scope: 'plan', demo: true });
      session.status = 'complete';
      const store = new SessionStore(directory);
      try { store.save(session); } finally { store.close(); }
      const args = ['--resume', session.id, '--headless', '--json', '--state-dir', directory];
      expect(JSON.parse((await cli(args)).stdout).scope).toBe('plan');
      await expect(cli([...args, '--read-only'])).rejects.toMatchObject({ stderr: expect.stringContaining('retain their permissions') });
      await expect(cli([...args, '--scope', 'build'])).rejects.toMatchObject({ stderr: expect.stringContaining('retain their permissions') });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('explains implicit headless execution without contaminating JSON output', async () => {
    const directory = await mkdtemp('/tmp/duet-cli-non-tty-');
    try {
      const inferred = await cli(['--demo', '--json', '--state-dir', directory]);
      expect(inferred.stderr).toContain('output is not an interactive terminal');
      expect(inferred.stderr).toContain('exiting at completion');
      expect(JSON.parse(inferred.stdout)).toMatchObject({ status: 'complete', turns: 7 });
      const explicit = await cli(['--demo', '--headless', '--json', '--state-dir', directory]);
      expect(explicit.stderr).not.toContain('output is not an interactive terminal');
      expect(JSON.parse(explicit.stdout)).toMatchObject({ status: 'complete', turns: 7 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 15_000);

  it('persists explicit models, preserves them on resume, and allows a single-provider override', async () => {
    const directory = await mkdtemp('/tmp/duet-cli-models-');
    try {
      const created = JSON.parse((await cli(['--demo', '--headless', '--json', '--state-dir', directory, '--claude-model', 'haiku', '--codex-model', 'test-codex-model', '--claude-effort', 'low', '--codex-effort', 'high'])).stdout);
      expect(created.models).toEqual({ claude: 'haiku', codex: 'test-codex-model' });
      expect(created.efforts).toEqual({ claude: 'low', codex: 'high' });
      const resumed = JSON.parse((await cli(['--resume', created.id, '--headless', '--json', '--state-dir', directory])).stdout);
      expect(resumed.models).toEqual(created.models);
      expect(resumed.efforts).toEqual(created.efforts);
      const changed = JSON.parse((await cli(['--resume', created.id, '--headless', '--json', '--state-dir', directory, '--claude-model', 'claude-haiku-4-5', '--codex-effort', 'default'])).stdout);
      expect(changed.models).toEqual({ claude: 'claude-haiku-4-5', codex: 'test-codex-model' });
      expect(changed.efforts).toEqual({ claude: 'low', codex: null });
      const store = new SessionStore(directory);
      try { expect(store.load(created.id)?.models).toEqual(changed.models); } finally { store.close(); }
      for (const model of ['', 'with spaces', '--invalid', 'x'.repeat(129)]) {
        await expect(cli(['--demo', '--headless', '--state-dir', directory, '--claude-model', model])).rejects.toMatchObject({ stderr: expect.stringContaining('--claude-model') });
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it('supports help, persisted headless results, listing, detach, reconnect, and remote pause', async () => {
    const directory = await mkdtemp('/tmp/duet-cli-');
    let remote: Awaited<ReturnType<typeof connectController>> | undefined;
    try {
      expect((await cli(['--help'])).stdout).toContain('--detach');
      const output = await cli(['--demo', '--headless', '--json', '--state-dir', directory]);
      const session = JSON.parse(output.stdout);
      expect(session).toMatchObject({ status: 'complete', turns: 7, demo: true });
      const store = new SessionStore(directory);
      try { expect(store.load(session.id)).toMatchObject({ status: 'complete', turns: 7 }); } finally { store.close(); }
      const listed = JSON.parse((await cli(['--list', '--json', '--state-dir', directory])).stdout);
      expect(listed).toContainEqual(expect.objectContaining({ id: session.id, status: 'complete', demo: true }));
      const detached = await cli(['--demo', '--detach', '--state-dir', directory]);
      const id = detached.stdout.match(/Detached session ([A-Za-z0-9_-]+)/)?.[1];
      expect(id).toBeTruthy();
      remote = await attach(directory, id!);
      remote.disconnect(); remote = undefined; // Detaching the UI must not stop the demonstration.
      await sleep(100);
      remote = await attach(directory, id!);
      await complete(remote);
      expect(remote.getView().session).toMatchObject({ id, status: 'complete', turns: 7 });
      remote.disconnect(); remote = await attach(directory, id!);
      expect(remote.getView().session.status).toBe('complete');
      await remote.send('Revisit the conclusion'); await remote.start(); await remote.close(); remote = undefined;
      remote = await attach(directory, id!);
      expect(remote.getView().session.status).toBe('paused');
      expect(remote.getView().session.messages.some(message => message.text === 'Revisit the conclusion')).toBe(true);
    } finally {
      remote?.disconnect();
      try { await stopFixtureWorkers(directory); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 25_000);
  it.each(['waiting_user', 'integration'] as const)('detaches a saved %s checkpoint without starting agent turns', async checkpoint => {
    const directory = await mkdtemp('/tmp/duet-cli-checkpoint-');
    let remote: Awaited<ReturnType<typeof connectController>> | undefined;
    try {
      const session = createSession({ project: '/tmp', scope: checkpoint === 'integration' ? 'build' : 'discuss', brief: 'Preserve this user checkpoint', demo: true });
      if (checkpoint === 'waiting_user') {
        session.status = 'waiting_user';
        session.decisions.push({ id: 'D7', kind: 'decision', title: 'Choose storage', proposal: 'Use SQLite', version: 1, tasks: [], rounds: 2, status: 'waiting_user', positions: { claude: { position: 'accept', reason: 'Local persistence', version: 1 }, codex: { position: 'object', reason: 'Clarify requirements first', version: 1 } } });
      } else {
        session.status = 'paused';
        session.integration = { status: 'review', path: '/tmp/combined-fixture', notes: 'Await combined validation' };
      }
      const store = new SessionStore(directory);
      try { store.save(session); } finally { store.close(); }
      if (checkpoint === 'waiting_user') {
        await expect(cli(['--resume', session.id, '--headless', '--max-turns', '2.5', '--state-dir', directory])).rejects.toMatchObject({ stderr: expect.stringContaining('--max-turns') });
      }
      const launched = await cli(['--resume', session.id, '--detach', '--state-dir', directory]);
      expect(launched.stdout).toContain(`Detached session ${session.id}`);
      remote = await attach(directory, session.id);
      await sleep(650); // An accidentally started demo emits activity immediately.
      const restored = remote.getView();
      expect(restored.session).toMatchObject({ id: session.id, status: session.status, turns: 0, activities: [], providerSessions: {} });
      expect(restored.busy).toEqual({ claude: false, codex: false });
      expect(restored.session.decisions).toEqual(session.decisions);
      expect(restored.session.integration).toEqual(session.integration);
      remote.disconnect(); remote = await attach(directory, session.id);
      expect(remote.getView().session.status).toBe(session.status);
    } finally {
      remote?.disconnect();
      try { await stopFixtureWorkers(directory); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 15_000);

});
