import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuetController } from '../src/controller.js';
import { createSession } from '../src/engine.js';
import type { AgentId, AgentProvider, AgentReply, ProviderEvent, ProviderTurn, Session } from '../src/types.js';

const emptyReply = (message = 'Independent idea'): AgentReply => ({ message, actions: [] });
interface Call {
  turn: ProviderTurn;
  emit: (event: ProviderEvent) => void;
  resolve: (reply: AgentReply) => void;
  reject: (error: Error) => void;
}
class FakeProvider implements AgentProvider {
  calls: Call[] = [];
  ignoreAbort = false;
  automatic?: (call: Call, number: number) => void;
  dispose = vi.fn(async () => {});
  constructor(readonly id: AgentId) {}
  run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply> {
    return new Promise((resolve, reject) => {
      const call = { turn, emit, resolve, reject };
      this.calls.push(call);
      if (!this.ignoreAbort) turn.signal.addEventListener('abort', () => resolve(emptyReply('Aborted output')), { once: true });
      this.automatic?.(call, this.calls.length);
    });
  }
}

const controllers: DuetController[] = [];
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.close(); });
function setup(session?: Session) {
  const claude = new FakeProvider('claude'), codex = new FakeProvider('codex');
  const saved: Session[] = [];
  const store = { save: vi.fn((value: Session) => { saved.push(structuredClone(value)); }) };
  const workspaces = { prepare: vi.fn(async (value: Session, agent: AgentId) => ({ cwd: `/tmp/${value.id}/${agent}`, writable: false })) };
  const controller = new DuetController(session ?? createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Compare designs', maxTurns: 8 }), { claude, codex }, store, workspaces);
  controllers.push(controller);
  return { controller, claude, codex, saved, store, workspaces };
}
const expectCalls = async (provider: FakeProvider, count: number) => { await vi.waitFor(() => expect(provider.calls).toHaveLength(count), { interval: 5, timeout: 1000 }); };

function finishedBuild(): Session {
  const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Build component', maxTurns: 20 });
  session.messages.push({ id: 'a', at: '', from: 'codex', to: 'claude', text: 'Reviewed component' }, { id: 'b', at: '', from: 'claude', to: 'codex', text: 'Component completed' });
  session.turns = 3;
  session.decisions = [{ id: 'plan', kind: 'plan', title: 'Component', proposal: 'Build component', version: 1, rounds: 0, status: 'agreed', tasks: [{ id: 'component', owner: 'claude', description: 'Implement component', dependsOn: [] }], positions: { claude: { position: 'accept', reason: 'Agreed', version: 1 }, codex: { position: 'accept', reason: 'Agreed', version: 1 } } }];
  session.completedTasks = { component: 'Implemented and tested' };
  session.finished.claude = 'Task completed';
  return session;
}

describe('autonomous collaboration controller', () => {
  it('passes each saved model selection and native session ID to its provider', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Compare designs' });
    session.models = { claude: 'haiku', codex: 'test-codex-model' };
    session.providerSessions = { claude: 'saved-claude', codex: 'saved-codex' };
    const { controller, claude, codex, saved } = setup(session);
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    expect(claude.calls[0]!.turn).toMatchObject({ model: 'haiku', sessionId: 'saved-claude' });
    expect(codex.calls[0]!.turn).toMatchObject({ model: 'test-codex-model', sessionId: 'saved-codex' });
    await controller.pause();
    expect(saved.at(-1)?.models).toEqual(session.models);
  });

  it('leaves native model defaults intact for legacy sessions without selections', async () => {
    const { controller, claude, codex } = setup();
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    expect(claude.calls[0]!.turn.model).toBeUndefined();
    expect(codex.calls[0]!.turn.model).toBeUndefined();
    await controller.pause();
  });

  it('starts both independent thoughts concurrently, then delivers peer context and finishes without forwarding', async () => {
    const { controller, claude, codex, saved, workspaces } = setup();
    for (const provider of [claude, codex]) provider.automatic = (call, number) => {
      call.resolve(number === 1 ? emptyReply(`${provider.id} initial perspective`) : { message: `${provider.id} joint conclusion`, actions: [{ type: 'finish', summary: 'Design explored' }] });
    };
    await controller.start(); await controller.wait();
    expect(claude.calls).toHaveLength(2); expect(codex.calls).toHaveLength(2);
    expect(claude.calls[0]!.turn.prompt).toContain('INITIAL INDEPENDENT EXPLORATION');
    expect(codex.calls[0]!.turn.prompt).toContain('INITIAL INDEPENDENT EXPLORATION');
    expect(claude.calls[0]!.turn.prompt).not.toContain('codex initial perspective');
    expect(codex.calls[0]!.turn.prompt).not.toContain('claude initial perspective');
    expect(claude.calls[1]!.turn.prompt).toContain('codex initial perspective');
    expect(codex.calls[1]!.turn.prompt).toContain('claude initial perspective');
    expect(controller.getView().session.status).toBe('complete');
    expect(controller.getView().session.turns).toBe(4);
    expect(saved.at(-1)?.status).toBe('complete');
    expect(workspaces.prepare).toHaveBeenCalledTimes(4);
  });

  it('ignores late provider events and replies after pause', async () => {
    const { controller, claude, codex, saved } = setup();
    claude.ignoreAbort = true;
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    const paused = controller.pause();
    expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
    claude.calls[0]!.emit({ type: 'session', sessionId: 'late-session' });
    claude.calls[0]!.emit({ type: 'text', text: 'Late streamed result' });
    claude.calls[0]!.resolve(emptyReply('Late final result'));
    await paused;
    const view = controller.getView();
    expect(view.session.status).toBe('paused');
    expect(view.session.turns).toBe(0);
    expect(view.session.messages.some(message => message.from === 'claude' || message.from === 'codex')).toBe(false);
    expect(view.session.providerSessions.claude).toBeUndefined();
    expect(view.streams.claude).toBe('');
    expect(view.busy).toEqual({ claude: false, codex: false });
    expect(saved.at(-1)?.status).toBe('paused');
  });

  it('queues steering until a tool boundary and restarts the recipient with the new instruction', async () => {
    const { controller, claude, codex } = setup();
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    await controller.send('Keep the design local', 'claude', 'queued');
    expect(claude.calls[0]!.turn.signal.aborted).toBe(false);
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
    claude.calls[0]!.emit({ type: 'tool_boundary' });
    expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
    codex.calls[0]!.resolve(emptyReply('Codex independent idea'));
    await expectCalls(claude, 2);
    expect(claude.calls[1]!.turn.prompt).toContain('Keep the design local');
    expect(controller.getView().session.messages.some(message => message.text === 'Aborted output')).toBe(false);
    expect(controller.getView().session.activities.some(activity => activity.text.includes('tool boundary'))).toBe(true);
  });

  it('discards a tool-free final reply when queued steering is still pending', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Explore' });
    session.messages.push({ id: 'a', at: '', from: 'claude', to: 'codex', text: 'Initial thought' }, { id: 'b', at: '', from: 'codex', to: 'claude', text: 'Peer thought' });
    session.turns = 2;
    const { controller, claude } = setup(session);
    await controller.start(); await expectCalls(claude, 1);
    await controller.send('Consider compatibility before finishing', 'claude', 'queued');
    expect(claude.calls[0]!.turn.signal.aborted).toBe(false);
    claude.calls[0]!.resolve({ message: 'Stale conclusion', actions: [{ type: 'finish', summary: 'Done without new constraint' }] });
    await expectCalls(claude, 2);
    expect(controller.getView().session.turns).toBe(2);
    expect(controller.getView().session.finished.claude).toBeUndefined();
    expect(controller.getView().session.messages.some(message => message.text === 'Stale conclusion')).toBe(false);
    expect(claude.calls[1]!.turn.prompt).toContain('Consider compatibility before finishing');
  });

  it('direct steering cancels autonomous peers and drops stale provider output', async () => {
    const { controller, claude, codex } = setup();
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    await controller.send('Investigate simpler alternatives', 'claude', 'immediate');
    expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
    claude.calls[0]!.emit({ type: 'session', sessionId: 'obsolete-session' });
    claude.calls[0]!.emit({ type: 'text', text: 'Obsolete output' });
    codex.calls[0]!.resolve(emptyReply('Codex independent idea'));
    await expectCalls(claude, 2);
    expect(claude.calls[1]!.turn.prompt).toContain('Investigate simpler alternatives');
    expect(controller.getView().session.providerSessions.claude).toBeUndefined();
    expect(controller.getView().streams.claude).not.toContain('Obsolete');
  });

  it('provider failure stops the other peer and persists the failure', async () => {
    const { controller, claude, codex, saved } = setup();
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    claude.calls[0]!.reject(new Error('Provider process disconnected'));
    await controller.wait();
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
    expect(controller.getView().session.status).toBe('error');
    expect(controller.getView().session.error).toContain('Provider process disconnected');
    expect(controller.getView().session.turns).toBe(0);
    expect(saved.at(-1)?.status).toBe('error');
  });

  it('a late failed-run cleanup cannot remove a newer turn abort handle or busy status', async () => {
    const { controller, claude, codex } = setup();
    codex.ignoreAbort = true;
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    claude.calls[0]!.reject(new Error('First run failed'));
    await controller.wait();
    await controller.start(); await expectCalls(claude, 2); await expectCalls(codex, 2);
    try {
      codex.calls[0]!.resolve(emptyReply('Old run finishes late'));
      await Promise.resolve(); await Promise.resolve();
      expect(controller.getView().busy.codex).toBe(true);
      const pausing = controller.pause();
      expect(codex.calls[1]!.turn.signal.aborted).toBe(true);
      codex.calls[1]!.resolve(emptyReply('Current run stopped'));
      await pausing;
    } finally {
      for (const call of codex.calls) call.resolve(emptyReply('Cleanup'));
      await controller.pause();
    }
  });

  it('resumes native session IDs and conversation while persisting new native IDs', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Continue exploring' });
    session.providerSessions = { claude: 'saved-claude', codex: 'saved-codex' };
    session.messages.push({ id: 'a', at: '', from: 'claude', to: 'codex', text: 'Earlier Claude observation' }, { id: 'b', at: '', from: 'codex', to: 'claude', text: 'Earlier Codex observation' });
    session.turns = 2;
    const { controller, claude, saved } = setup(session);
    await controller.start(); await expectCalls(claude, 1);
    expect(claude.calls[0]!.turn.sessionId).toBe('saved-claude');
    expect(claude.calls[0]!.turn.prompt).toContain('Earlier Codex observation');
    expect(claude.calls[0]!.turn.prompt).not.toContain('INITIAL INDEPENDENT EXPLORATION');
    claude.calls[0]!.emit({ type: 'session', sessionId: 'updated-claude' });
    await controller.pause();
    expect(saved.at(-1)?.providerSessions.claude).toBe('updated-claude');
  });

  it('preserves user steering and pause while asynchronous task finalization is pending', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Implement agreed work', maxTurns: 3 });
    session.messages.push({ id: 'a', at: '', from: 'claude', to: 'codex', text: 'Initial thought' }, { id: 'b', at: '', from: 'codex', to: 'claude', text: 'Peer thought' });
    session.turns = 2;
    session.decisions = [{ id: 'plan', kind: 'plan', title: 'Accepted plan', proposal: 'Implement component', version: 1, rounds: 0, status: 'agreed', tasks: [{ id: 'component', owner: 'claude', description: 'Implement component', dependsOn: [] }], positions: { claude: { position: 'accept', reason: 'Fits scope', version: 1 }, codex: { position: 'accept', reason: 'Fits scope', version: 1 } } }];
    const { controller, claude, workspaces } = setup(session);
    let finishFinalization!: (value: string | null) => void;
    const finalize = vi.fn(() => new Promise<string | null>(resolve => { finishFinalization = resolve; }));
    Object.assign(workspaces, { finalize });
    await controller.start(); await expectCalls(claude, 1);
    claude.calls[0]!.resolve({ message: 'Component done', actions: [{ type: 'complete_task', id: 'component', summary: 'Implemented' }] });
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce(), { interval: 5 });
    await controller.send('Wait: reconsider this component', 'both', 'immediate');
    const pausing = controller.pause();
    finishFinalization(null);
    await pausing;
    expect(controller.getView().session.messages.some(message => message.text === 'Wait: reconsider this component')).toBe(true);
    expect(controller.getView().session.status).toBe('paused');
    expect(controller.getView().session.completedTasks.component).toBeUndefined();
  });

  it('retains queued user instructions arriving during asynchronous finalization', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Implement agreed work', maxTurns: 3 });
    session.messages.push({ id: 'a', at: '', from: 'claude', to: 'codex', text: 'Initial thought' }, { id: 'b', at: '', from: 'codex', to: 'claude', text: 'Peer thought' });
    session.turns = 2;
    session.decisions = [{ id: 'plan', kind: 'plan', title: 'Accepted plan', proposal: 'Implement component', version: 1, rounds: 0, status: 'agreed', tasks: [{ id: 'component', owner: 'claude', description: 'Implement component', dependsOn: [] }], positions: { claude: { position: 'accept', reason: 'Fits scope', version: 1 }, codex: { position: 'accept', reason: 'Fits scope', version: 1 } } }];
    const { controller, claude, workspaces } = setup(session);
    let finishFinalization!: (value: string | null) => void;
    const finalize = vi.fn(() => new Promise<string | null>(resolve => { finishFinalization = resolve; }));
    Object.assign(workspaces, { finalize });
    await controller.start(); await expectCalls(claude, 1);
    claude.calls[0]!.resolve({ message: 'Component done', actions: [{ type: 'complete_task', id: 'component', summary: 'Implemented' }] });
    await vi.waitFor(() => expect(finalize).toHaveBeenCalledOnce(), { interval: 5 });
    await controller.send('Include compatibility notes next', 'both', 'queued');
    finishFinalization(null);
    await controller.wait();
    expect(controller.getView().session.messages.some(message => message.text === 'Include compatibility notes next')).toBe(true);
    expect(controller.getView().session.completedTasks.component).toBe('Implemented');
  });

  it('persists pending integration before merging and requires validation evidence to complete', async () => {
    const { controller, codex, claude, workspaces, saved } = setup(finishedBuild());
    let completeMerge!: (result: { path: string; conflicts: boolean }) => void;
    const merge = vi.fn(() => new Promise<{ path: string; conflicts: boolean }>(resolve => { completeMerge = resolve; }));
    Object.assign(workspaces, { merge });
    await controller.start(); await expectCalls(codex, 1);
    codex.calls[0]!.resolve({ message: 'Build concluded', actions: [{ type: 'finish', summary: 'Build concluded' }] });
    await vi.waitFor(() => expect(merge).toHaveBeenCalledOnce(), { interval: 5 });
    expect(controller.getView().session.status).toBe('paused');
    expect(controller.getView().session.integration?.status).toBe('pending');
    expect(saved.some(snapshot => snapshot.integration?.status === 'pending' && snapshot.status === 'paused')).toBe(true);
    expect(saved.some(snapshot => snapshot.status === 'complete')).toBe(false);
    completeMerge({ path: '/tmp/combined', conflicts: false });
    await controller.wait();
    expect(controller.getView().session.integration).toEqual({ status: 'review', path: '/tmp/combined' });
    await expect(controller.start()).rejects.toThrow('awaiting validation');
    await expect(controller.acceptIntegration('   ')).rejects.toThrow('validation');
    await controller.acceptIntegration('Combined unit tests and smoke test passed');
    expect(controller.getView().session.status).toBe('complete');
    expect(saved.at(-1)?.integration).toEqual({ status: 'accepted', path: '/tmp/combined', notes: 'Combined unit tests and smoke test passed' });
    expect(claude.calls).toHaveLength(0); expect(codex.calls).toHaveLength(1);
  });

  it('recovers pending integration by merging without starting either provider', async () => {
    const session = finishedBuild();
    session.finished.codex = 'Done'; session.integration = { status: 'pending' };
    const { controller, claude, codex, workspaces, saved } = setup(session);
    const merge = vi.fn(async () => ({ path: '/tmp/recovered-candidate', conflicts: false }));
    Object.assign(workspaces, { merge });
    await controller.start();
    expect(merge).toHaveBeenCalledOnce();
    expect(claude.calls).toHaveLength(0); expect(codex.calls).toHaveLength(0);
    expect(saved.at(-1)?.integration).toEqual({ status: 'review', path: '/tmp/recovered-candidate' });
    expect(controller.getView().session.status).toBe('paused');
  });

  it('coalesces repeated resume requests while recovery integration is pending', async () => {
    const session = finishedBuild(); session.integration = { status: 'pending' };
    const { controller, workspaces } = setup(session);
    let resolveMerge!: (result: { path: string; conflicts: boolean }) => void;
    const merging = new Promise<{ path: string; conflicts: boolean }>(resolve => { resolveMerge = resolve; });
    const merge = vi.fn(() => merging);
    Object.assign(workspaces, { merge });
    const first = controller.start();
    const second = controller.start();
    try { expect(merge).toHaveBeenCalledOnce(); }
    finally { resolveMerge({ path: '/tmp/recovered-candidate', conflicts: false }); await Promise.allSettled([first, second]); }
  });

  it('waits for recovery integration before closing provider resources', async () => {
    const session = finishedBuild(); session.integration = { status: 'pending' };
    const { controller, workspaces, claude, codex } = setup(session);
    let resolveMerge!: (result: { path: string; conflicts: boolean }) => void;
    const merging = new Promise<{ path: string; conflicts: boolean }>(resolve => { resolveMerge = resolve; });
    Object.assign(workspaces, { merge: vi.fn(() => merging) });
    const starting = controller.start();
    let closed = false;
    const closing = controller.close().then(() => { closed = true; });
    await Promise.resolve(); await Promise.resolve();
    try {
      expect(closed).toBe(false);
      expect(claude.dispose).not.toHaveBeenCalled();
      expect(codex.dispose).not.toHaveBeenCalled();
    } finally {
      resolveMerge({ path: '/tmp/recovered-candidate', conflicts: false });
      await Promise.allSettled([starting, closing]);
    }
    expect(closed).toBe(true);
    expect(claude.dispose).toHaveBeenCalledOnce();
    expect(codex.dispose).toHaveBeenCalledOnce();
    expect(controller.getView().session.status).toBe('paused');
  });

  it('retries conflict integration on explicit resume and refuses acceptance until conflict-free', async () => {
    const session = finishedBuild();
    session.finished.codex = 'Done'; session.integration = { status: 'conflicts', path: '/tmp/conflicted-candidate' };
    const { controller, claude, codex, workspaces } = setup(session);
    const merge = vi.fn(async () => ({ path: '/tmp/resolved-candidate', conflicts: false }));
    Object.assign(workspaces, { merge });
    await expect(controller.acceptIntegration('Tests passed')).rejects.toThrow('conflict-free');
    await controller.start();
    expect(merge).toHaveBeenCalledOnce();
    expect(controller.getView().session.integration).toEqual({ status: 'review', path: '/tmp/resolved-candidate' });
    expect(claude.calls).toHaveLength(0); expect(codex.calls).toHaveLength(0);
    await controller.acceptIntegration('Resolved conflicts and validated combined output');
    expect(controller.getView().session.status).toBe('complete');
  });

  it('stops at the exact turn allowance without automatically renewing it', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Explore', maxTurns: 3 });
    const { controller, claude, codex, saved } = setup(session);
    for (const provider of [claude, codex]) provider.automatic = call => call.resolve(emptyReply(`${provider.id} idea`));
    await controller.start(); await controller.wait();
    expect(controller.getView().session.status).toBe('paused');
    expect(controller.getView().session.turns).toBe(3);
    expect(controller.getView().session.maxTurns).toBe(3);
    expect(saved.at(-1)?.messages.at(-1)?.text).toContain('Turn limit reached');
    expect(claude.calls.length + codex.calls.length).toBe(3);
  });

  it('stops on elapsed-time allowance and aborts both active peers without renewing it', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Explore', maxMinutes: 0.001 });
    const { controller, claude, codex } = setup(session);
    await controller.start(); await expectCalls(claude, 1); await expectCalls(codex, 1);
    await controller.wait();
    expect(controller.getView().session.status).toBe('paused');
    expect(controller.getView().session.maxMinutes).toBe(0.001);
    expect(controller.getView().session.messages.at(-1)?.text).toContain('time limit');
    expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
  });
});

function setupSolo(brief = '') {
  const session = createSession({ project: '/tmp/project', scope: 'discuss', brief, maxTurns: 12, agents: [{ id: 'agent-1', provider: 'codex' }] });
  session.agents = [{ id: 'agent-1', provider: 'codex' }];
  session.providerModels = { codex: 'small-codex', claude: 'haiku' };
  session.models = { 'agent-1': 'small-codex' };
  const first = new FakeProvider('agent-1');
  const providers: Record<string, FakeProvider> = { 'agent-1': first };
  const factory = vi.fn((config: { id: string; provider: string }) => { const provider = new FakeProvider(config.id); providers[config.id] = provider; return provider; });
  const workspaces = { prepare: vi.fn(async () => ({ cwd: '/tmp/project', writable: false })) };
  const controller = new DuetController(session, { 'agent-1': first }, { save: vi.fn() }, workspaces, factory);
  controllers.push(controller);
  return { controller, first, providers, factory };
}

describe('dynamic agent instances', () => {
  it.each(['pending', 'review', 'conflicts'] as const)('preserves a %s integration checkpoint when adding an agent is requested', async status => {
    const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Build', agents: [{ id: 'agent-1', provider: 'codex' }] });
    session.integration = { status, path: '/tmp/candidate' };
    session.finished = { 'agent-1': 'Done' };
    const factory = vi.fn(() => new FakeProvider('agent-2'));
    const controller = new DuetController(session, { 'agent-1': new FakeProvider('agent-1') }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } }, factory);
    controllers.push(controller);
    const before = controller.getView().session;
    await expect(controller.addAgent('codex')).rejects.toThrow('Validate the pending integration');
    expect(controller.getView().session).toEqual(before);
    expect(factory).not.toHaveBeenCalled();
  });
  it('requires fresh agreement when a peer joins an already validated build', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Build', agents: [{ id: 'agent-1', provider: 'codex' }] });
    session.integration = { status: 'accepted', path: '/tmp/candidate', notes: 'Validated' };
    session.decisions = [{ id: 'plan', kind: 'plan', title: 'Plan', proposal: 'Build', version: 1, tasks: [], positions: { 'agent-1': { version: 1, position: 'accept', reason: 'Ready' } }, rounds: 0, status: 'agreed' }];
    const controller = new DuetController(session, { 'agent-1': new FakeProvider('agent-1') }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } }, () => new FakeProvider('agent-2'));
    controllers.push(controller);
    await controller.addAgent('codex');
    expect(controller.getView().session.integration).toBeUndefined();
    expect(controller.getView().session.decisions[0]).toMatchObject({ status: 'open', positions: {} });
    await expect(controller.acceptIntegration('Old evidence')).rejects.toThrow('No conflict-free');
  });
  it('opens a blank solo composer without requests and answers once per user message', async () => {
    const { controller, first } = setupSolo();
    await controller.start();
    expect(first.calls).toHaveLength(0);
    expect(controller.getView()).toMatchObject({ recipient: 'agent-1', streams: { 'agent-1': '' }, session: { awaitingInput: true } });
    first.automatic = call => call.resolve(emptyReply('An answer'));
    await controller.send('Explain the project'); await controller.wait();
    expect(first.calls).toHaveLength(1);
    expect(controller.getView().session).toMatchObject({ brief: 'Explain the project', status: 'paused', awaitingInput: true });
    expect(first.calls[0]!.turn.prompt).not.toContain('INITIAL INDEPENDENT EXPLORATION');
    await controller.send('Another question'); await controller.wait();
    expect(first.calls).toHaveLength(2);
  });

  it('does not resume a deliberately paused solo conversation when instructions are queued', async () => {
    const { controller, first } = setupSolo();
    await controller.pause();
    await controller.send('Wait for my resume');
    expect(first.calls).toHaveLength(0);
    expect(controller.getView().session.awaitingInput).toBe(false);
    await controller.start(); await expectCalls(first, 1);
  });

  it('selects the initial provider before conversation and rejects later replacement', async () => {
    const { controller, first, providers, factory } = setupSolo();
    await controller.setInitialAgent('claude');
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith({ id: 'agent-1', provider: 'claude' });
    expect(controller.getView().session.models).toEqual({ 'agent-1': 'haiku' });
    providers['agent-1']!.automatic = call => call.resolve(emptyReply());
    await controller.send('Hello'); await controller.wait();
    await expect(controller.setInitialAgent('codex')).rejects.toThrow('before the conversation');
  });

  it('adds a peer to blank input without running either agent and rejects a third', async () => {
    const { controller, first, providers } = setupSolo();
    await controller.addAgent('codex');
    expect(first.calls).toHaveLength(0); expect(providers['agent-2']!.calls).toHaveLength(0);
    expect(controller.getView().session.agents).toEqual([{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'codex' }]);
    await expect(controller.addAgent('claude')).rejects.toThrow('already has two');
    await expect(controller.send('Hello', 'codex')).rejects.toThrow('Unknown message recipient');
    expect(() => controller.setRecipient('missing')).toThrow('Unknown message recipient');
  });

  it('shares solo context only after explicit collaboration while keeping native sessions independent', async () => {
    const { controller, first, providers } = setupSolo();
    first.automatic = call => { call.emit({ type: 'session', sessionId: 'first-native-thread' }); call.resolve(emptyReply('First perspective')); };
    await controller.send('Discuss a small cache'); await controller.wait();
    await controller.addAgent('codex');
    const second = providers['agent-2']!; expect(second.calls).toHaveLength(0);
    expect(controller.getView().session.messages.find(m => m.from === 'user')?.to).toBe('agent-1');
    await controller.collaborate('Discuss a small cache together'); await expectCalls(second, 1);
    expect(second.calls[0]!.turn).toMatchObject({ agent: 'agent-2', model: 'small-codex' });
    expect(second.calls[0]!.turn.sessionId).toBeUndefined();
    expect(second.calls[0]!.turn.prompt).toContain('First perspective');
    expect(second.calls[0]!.turn.prompt).toContain('JOINING EXISTING CONVERSATION');
    expect(second.calls[0]!.turn.prompt).not.toContain('INITIAL INDEPENDENT EXPLORATION');
    second.calls[0]!.emit({ type: 'session', sessionId: 'second-native-thread' });
    await controller.pause();
    expect(controller.getView().session.providerSessions).toEqual({ 'agent-1': 'first-native-thread', 'agent-2': 'second-native-thread' });
    expect(controller.getView().session.messages.filter(m => m.from === 'user').every(m => m.to === 'both')).toBe(true);
  });

  it('reopens previous agent agreement when a peer joins and keeps user resolution binding', async () => {
    const { controller, first } = setupSolo();
    first.automatic = call => call.resolve(emptyReply());
    await controller.send('Discuss'); await controller.wait();
    const session = controller.getView().session;
    session.decisions = [
      { id: 'ordinary', kind: 'decision', title: 'Cache', proposal: 'Memory', version: 1, tasks: [], rounds: 2, status: 'agreed', positions: { 'agent-1': { position: 'accept', reason: 'Fine', version: 1 } } },
      { id: 'binding', kind: 'decision', title: 'Storage', proposal: 'Disk', version: 1, tasks: [], rounds: 0, status: 'agreed', positions: {}, userResolution: 'Use disk' },
    ];
    await controller.close();
    const peer = new FakeProvider('agent-2');
    const restored = new DuetController(session, { 'agent-1': new FakeProvider('agent-1') }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } }, () => peer);
    controllers.push(restored);
    await restored.addAgent('claude'); expect(peer.calls).toHaveLength(0);
    expect(restored.getView().session.decisions[0]).toMatchObject({ status: 'open', positions: {}, rounds: 0 });
    expect(restored.getView().session.decisions[1]).toMatchObject({ status: 'agreed', userResolution: 'Use disk' });
  });

  it('pauses a pending solo turn before joining and ignores its aborted output', async () => {
    const { controller, first, providers } = setupSolo();
    await controller.send('Discuss safe cancellation'); await expectCalls(first, 1);
    await controller.addAgent('claude');
    expect(first.calls[0]!.turn.signal.aborted).toBe(true);
    expect(controller.getView().session.messages.some(m => m.text === 'Aborted output')).toBe(false);
    expect(providers['agent-2']!.calls).toHaveLength(0);
    expect(first.calls).toHaveLength(1);
    await controller.start(); await expectCalls(first, 2);
    expect(providers['agent-2']!.calls).toHaveLength(0);
  });

  it('accepts a message after adding a peer during an active reply without manual resume', async () => {
    const { controller, first, providers } = setupSolo();
    await controller.send('First question'); await expectCalls(first, 1);
    await controller.addAgent('claude');
    const second = providers['agent-2']!;
    first.automatic = call => call.resolve(emptyReply('First answer'));
    second.automatic = call => call.resolve(emptyReply('Second answer'));
    expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(0);
    await controller.send('Second question', 'agent-2'); await controller.wait();
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.turn.prompt).toContain('Second question');
    expect(second.calls[0]!.turn.prompt).not.toContain('First question');
    expect(controller.getView().session).toMatchObject({ awaitingInput: true, pendingRecipients: [] });
  });
});

describe('instance message routing', () => {
  it('delivers a directed message only to its chosen instance and shared messages to both', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Shared project context', agents: [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'codex' }] });
    session.messages.push({ id: 'one', at: '', from: 'agent-1', to: 'both', text: 'First thoughts' }, { id: 'two', at: '', from: 'agent-2', to: 'both', text: 'Second thoughts' });
    const first = new FakeProvider('agent-1'), second = new FakeProvider('agent-2');
    const controller = new DuetController(session, { 'agent-1': first, 'agent-2': second }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } });
    controllers.push(controller);
    await controller.send('For the first instance only', 'agent-1');
    await controller.send('For the whole team', 'both');
    await controller.start(); await expectCalls(first, 1);
    expect(first.calls[0]!.turn.prompt).toContain('For the first instance only');
    expect(first.calls[0]!.turn.prompt).toContain('For the whole team');
    first.calls[0]!.resolve(emptyReply('First response'));
    await expectCalls(second, 1);
    expect(second.calls[0]!.turn.prompt).not.toContain('For the first instance only');
    expect(second.calls[0]!.turn.prompt).toContain('For the whole team');
  });
});

it('keeps unresolved user checkpoints when a peer joins and reopens user-resolved plan approval', async () => {
  const session = createSession({ project: '/tmp/project', scope: 'plan', brief: 'Plan changes', agents: [{ id: 'agent-1', provider: 'codex' }] });
  session.status = 'waiting_user';
  session.decisions = [
    { id: 'blocked', kind: 'decision', title: 'Choice', proposal: 'Option', version: 1, tasks: [], rounds: 3, status: 'waiting_user', positions: { 'agent-1': { position: 'object', reason: 'Needs input', version: 1 } } },
    { id: 'plan', kind: 'plan', title: 'Plan', proposal: 'Implement', version: 1, tasks: [], rounds: 0, status: 'agreed', positions: { 'agent-1': { position: 'accept', reason: 'Ready', version: 1 } }, userResolution: 'Use the small implementation' },
  ];
  const first = new FakeProvider('agent-1'), second = new FakeProvider('agent-2');
  const controller = new DuetController(session, { 'agent-1': first }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } }, () => second);
  controllers.push(controller);
  await controller.addAgent('claude');
  expect(controller.getView().session.decisions[0]).toMatchObject({ status: 'waiting_user', rounds: 3, positions: { 'agent-1': { position: 'object' } } });
  expect(controller.getView().session.decisions[1]).toMatchObject({ status: 'open', positions: {}, userResolution: 'Use the small implementation' });
  expect(first.calls).toHaveLength(0); expect(second.calls).toHaveLength(0);
  await expect(controller.start()).rejects.toThrow('Resolve the pending decision');
});

it('initially runs only the explicitly addressed instance in a blank dual conversation', async () => {
  const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents: [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'claude' }] });
  const first = new FakeProvider('agent-1'), second = new FakeProvider('agent-2');
  const controller = new DuetController(session, { 'agent-1': first, 'agent-2': second }, { save() {} }, { async prepare() { return { cwd: '/tmp/project', writable: false }; } });
  controllers.push(controller);
  await controller.send('Start with the second agent', 'agent-2');
  await expectCalls(second, 1);
  expect(first.calls).toHaveLength(0);
  second.calls[0]!.resolve({ message: 'Hi!', actions: [{ type: 'finish', summary: 'Ready' }] });
  await controller.wait();
  expect(first.calls).toHaveLength(0); expect(second.calls).toHaveLength(1);
  expect(controller.getView().session).toMatchObject({ status: 'paused', awaitingInput: true, pendingRecipients: [], finished: {} });
});

describe('direct chat scheduling', () => {
  function dual() {
    return setup(createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents: [{ id: 'codex', provider: 'codex' }, { id: 'claude', provider: 'claude' }] }));
  }
  it('answers Hi only once on Codex, waits for input, and never polls on resume', async () => {
    const { controller, codex, claude } = dual();
    codex.automatic = call => call.resolve({ message: 'Hi!', actions: [{ type: 'finish', summary: 'Ready' }] });
    await controller.send('Hi', 'codex'); await controller.wait();
    expect(codex.calls).toHaveLength(1); expect(claude.calls).toHaveLength(0);
    expect(controller.getView().session).toMatchObject({ interaction: 'chat', status: 'paused', awaitingInput: true, pendingRecipients: [] });
    expect(codex.calls[0]!.turn.prompt).not.toContain('INITIAL INDEPENDENT EXPLORATION');
    await controller.start(); await controller.wait();
    expect(codex.calls).toHaveLength(1); expect(claude.calls).toHaveLength(0);
    await controller.send('Thanks', 'codex'); await controller.wait();
    expect(codex.calls).toHaveLength(2); expect(claude.calls).toHaveLength(0);
  });
  it('starts both broadcast recipients before either replies and saves the faster answer immediately', async () => {
    const { controller, codex, claude } = dual();
    await controller.send('Your opinion?', 'both');
    await expectCalls(codex, 1); await expectCalls(claude, 1);
    expect(controller.getView().busy).toEqual({ codex: true, claude: true });
    claude.calls[0]!.resolve(emptyReply('claude answer'));
    await vi.waitFor(() => expect(controller.getView().session.pendingRecipients).toEqual(['codex']), { interval: 5 });
    expect(controller.getView().session.messages.at(-1)).toMatchObject({ from: 'claude', to: 'claude', text: 'claude answer' });
    expect(controller.getView().busy.codex).toBe(true);
    codex.calls[0]!.resolve(emptyReply('codex answer')); await controller.wait();
    expect(codex.calls).toHaveLength(1); expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]!.turn.prompt).not.toContain('codex answer');
    expect(controller.getView().session).toMatchObject({ awaitingInput: true, pendingRecipients: [] });
  });
  it('retains pending recipient turns over pause and persisted restoration without replaying accepted replies', async () => {
    const { controller, codex, claude, saved } = dual();
    codex.automatic = call => call.resolve(emptyReply('Codex answered'));
    await controller.send('Both answer', 'both'); await expectCalls(claude, 1);
    await vi.waitFor(() => expect(controller.getView().session.pendingRecipients).toEqual(['claude']), { interval: 5 });
    await controller.pause();
    expect(saved.at(-1)?.pendingRecipients).toEqual(['claude']);
    const restored = setup(structuredClone(saved.at(-1)!));
    restored.claude.automatic = call => call.resolve(emptyReply('Claude answered'));
    await restored.controller.start(); await restored.controller.wait();
    expect(restored.codex.calls).toHaveLength(0); expect(restored.claude.calls).toHaveLength(1);
    expect(restored.controller.getView().session).toMatchObject({ awaitingInput: true, pendingRecipients: [] });
  });
  it('starts a newly addressed peer while the first agent is busy and steers only the first agent', async () => {
    const { controller, codex, claude } = dual();
    await controller.send('Initial question', 'codex'); await expectCalls(codex, 1);
    await controller.send('Independent question', 'claude');
    await expectCalls(claude, 1);
    expect(controller.getView().busy).toEqual({ codex: true, claude: true });
    await controller.send('Use this additional detail', 'codex', 'queued');
    codex.calls[0]!.emit({ type: 'tool_boundary' }); await expectCalls(codex, 2);
    expect(claude.calls[0]!.turn.signal.aborted).toBe(false);
    expect(codex.calls[1]!.turn.prompt).toContain('Use this additional detail');
    codex.calls[1]!.resolve(emptyReply('New answer')); await expectCalls(claude, 1);
    claude.calls[0]!.resolve(emptyReply('Independent answer')); await controller.wait();
    expect(codex.calls).toHaveLength(2); expect(claude.calls).toHaveLength(1);
    expect(controller.getView().session.pendingRecipients).toEqual([]);
  });
  it('runs two instances of Codex concurrently without sharing their replies', async () => {
    const { controller, first, providers } = setupSolo();
    await controller.addAgent('codex');
    const second = providers['agent-2']!;
    await controller.send('Compare the options', 'both');
    await expectCalls(first, 1); await expectCalls(second, 1);
    expect(controller.getView().busy).toEqual({ 'agent-1': true, 'agent-2': true });
    second.calls[0]!.resolve(emptyReply('Second Codex response'));
    first.calls[0]!.resolve(emptyReply('First Codex response')); await controller.wait();
    expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(1);
    expect(controller.getView().session.messages.filter(m => m.from !== 'user').map(m => m.to).sort()).toEqual(['agent-1', 'agent-2']);
  });
  it('processes another request for the faster agent while its peer remains busy', async () => {
    const { controller, codex, claude } = dual();
    await controller.send('Both answer', 'both');
    await expectCalls(codex, 1); await expectCalls(claude, 1);
    claude.calls[0]!.resolve(emptyReply('First answer'));
    await vi.waitFor(() => expect(controller.getView().session.pendingRecipients).toEqual(['codex']), { interval: 5 });
    await controller.send('Follow up', 'claude'); await expectCalls(claude, 2);
    expect(codex.calls[0]!.turn.signal.aborted).toBe(false);
    claude.calls[1]!.resolve(emptyReply('Follow up answer'));
    codex.calls[0]!.resolve(emptyReply('Slower answer')); await controller.wait();
    expect(controller.getView().session).toMatchObject({ turns: 3, pendingRecipients: [], awaitingInput: true });
  });
  it('reserves the remaining turn allowance before starting concurrent requests', async () => {
    const session = createSession({ project: '/tmp/project', scope: 'discuss', brief: '', maxTurns: 1, agents: [{ id: 'codex', provider: 'codex' }, { id: 'claude', provider: 'claude' }] });
    const { controller, codex, claude } = setup(session);
    await controller.send('Both answer', 'both'); await expectCalls(codex, 1);
    expect(claude.calls).toHaveLength(0);
    codex.calls[0]!.resolve(emptyReply()); await controller.wait();
    expect(claude.calls).toHaveLength(0);
    expect(controller.getView().session).toMatchObject({ turns: 1, pendingRecipients: ['claude'], status: 'paused', awaitingInput: false });
  });
  it('cancels both direct requests on pause without accepting their aborted replies', async () => {
    const { controller, codex, claude } = dual();
    await controller.send('Both answer', 'both');
    await expectCalls(codex, 1); await expectCalls(claude, 1);
    await controller.pause();
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
    expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
    expect(controller.getView().session).toMatchObject({ turns: 0, pendingRecipients: ['codex', 'claude'], awaitingInput: false });
  });
  it('reruns only the immediately steered recipient, consumes the response, and keeps the peer idle', async () => {
    const { controller, codex, claude } = dual();
    await controller.send('First instruction', 'codex'); await expectCalls(codex, 1);
    await controller.send('Replacement instruction', 'codex', 'immediate'); await expectCalls(codex, 2);
    codex.calls[1]!.resolve(emptyReply('Current answer')); await controller.wait();
    expect(codex.calls[0]!.turn.signal.aborted).toBe(true);
    expect(codex.calls).toHaveLength(2); expect(claude.calls).toHaveLength(0);
    expect(controller.getView().session).toMatchObject({ pendingRecipients: [], awaitingInput: true });
  });
  it('requires a task and a second agent to explicitly enable collaboration', async () => {
    const solo = setupSolo();
    await expect(solo.controller.collaborate('Discuss implementation')).rejects.toThrow('second agent');
    const { controller, codex, claude } = dual();
    await expect(controller.collaborate(' ')).rejects.toThrow('task');
    expect(codex.calls).toHaveLength(0); expect(claude.calls).toHaveLength(0);
  });
  it('keeps a direct follow-up private after completed explicit collaboration', async () => {
    const { controller, codex, claude } = dual();
    for (const provider of [codex, claude]) provider.automatic = (call, n) => call.resolve(n === 1 ? emptyReply('Initial idea') : { message: 'Done', actions: [{ type: 'finish', summary: 'Concluded' }] });
    await controller.collaborate('Brainstorm cache strategies'); await controller.wait();
    expect(controller.getView().session.status).toBe('complete');
    const claudeTurns = claude.calls.length, codexTurns = codex.calls.length;
    codex.automatic = call => call.resolve(emptyReply('Hi!'));
    await controller.send('Hi', 'codex'); await controller.wait();
    expect(codex.calls).toHaveLength(codexTurns + 1); expect(claude.calls).toHaveLength(claudeTurns);
    expect(controller.getView().session).toMatchObject({ interaction: 'chat', awaitingInput: true });
    expect(controller.getView().session.messages.at(-1)).toMatchObject({ from: 'codex', to: 'codex' });
  });
  it('rejects invalid collaboration actions once rather than retrying forever in direct chat', async () => {
    const { controller, codex, claude } = dual();
    codex.automatic = call => call.resolve({ message: 'Invalid vote', actions: [{ type: 'position', id: 'nonexistent', version: 1, position: 'accept', reason: 'Missing' }] });
    await controller.send('Hi', 'codex'); await controller.wait();
    expect(codex.calls).toHaveLength(1); expect(claude.calls).toHaveLength(0);
    expect(controller.getView().session).toMatchObject({ awaitingInput: true, pendingRecipients: [], turns: 1 });
  });
});

it.each([false, true])('finishes an edits-enabled discussion without integration (empty agreed plan: %s)', async withPlan => {
  const session = createSession({ project: '/tmp/project', brief: 'Brainstorm approaches' });
  if (withPlan) session.decisions = [{ id: 'plan', kind: 'plan', title: 'Recommendation', proposal: 'Keep it simple', version: 1, tasks: [], rounds: 0, status: 'agreed', positions: { codex: { version: 1, position: 'accept', reason: 'Agreed' }, claude: { version: 1, position: 'accept', reason: 'Agreed' } } }];
  const { controller, codex, claude, workspaces } = setup(session);
  const merge = vi.fn(); Object.assign(workspaces, { merge });
  for (const provider of [codex, claude]) provider.automatic = (call, n) => call.resolve(n === 1 ? emptyReply('Initial idea') : { message: 'Recommendation', actions: [{ type: 'finish', summary: 'Discussed' }] });
  await controller.start(); await controller.wait();
  expect(controller.getView().session).toMatchObject({ scope: 'build', status: 'complete', turns: 4 });
  expect(controller.getView().session.integration).toBeUndefined();
  expect(merge).not.toHaveBeenCalled();
  expect(codex.calls.every(call => !call.turn.writable)).toBe(true);
  expect(claude.calls.every(call => !call.turn.writable)).toBe(true);
});

it('finalizes a completed direct solo build and requires combined candidate validation without finish', async () => {
  const session = createSession({ project: '/tmp/project', scope: 'build', brief: 'Implement the authorized component', agents: [{ id: 'codex', provider: 'codex' }] });
  session.decisions = [{ id: 'plan', kind: 'plan', title: 'Component', proposal: 'Implement component', version: 1, tasks: [{ id: 'component', owner: 'codex', description: 'Implement component', dependsOn: [] }], rounds: 0, status: 'agreed', positions: { codex: { version: 1, position: 'accept', reason: 'Agreed' } } }];
  const { controller, codex, workspaces, saved } = setup(session);
  const finalize = vi.fn(async () => 'committed-component');
  const merge = vi.fn(async () => ({ path: '/tmp/solo-candidate', conflicts: false }));
  Object.assign(workspaces, { prepare: vi.fn(async () => ({ cwd: '/tmp/solo-worktree', writable: true })), finalize, merge });
  codex.automatic = call => call.resolve({ message: 'Implemented and tested', actions: [{ type: 'complete_task', id: 'component', summary: 'Implemented and tested' }] });
  await controller.start(); await controller.wait();
  expect(codex.calls).toHaveLength(1); expect(finalize).toHaveBeenCalledOnce(); expect(merge).toHaveBeenCalledOnce();
  expect(saved.some(value => value.integration?.status === 'pending' && value.status === 'paused')).toBe(true);
  expect(controller.getView().session).toMatchObject({ status: 'paused', pendingRecipients: [], integration: { status: 'review', path: '/tmp/solo-candidate' } });
  await expect(controller.start()).rejects.toThrow('awaiting validation');
  await controller.acceptIntegration('Component and combined tests pass');
  expect(controller.getView().session).toMatchObject({ status: 'complete', integration: { status: 'accepted' } });
});

it('retains other direct recipients across a completed build integration checkpoint', async () => {
  const session = createSession({ project: '/tmp/project', scope: 'build', brief: '', agents: [{ id: 'codex', provider: 'codex' }, { id: 'claude', provider: 'claude' }] });
  session.decisions = [{ id: 'plan', kind: 'plan', title: 'Component', proposal: 'Implement component', version: 1, tasks: [{ id: 'component', owner: 'codex', description: 'Implement component', dependsOn: [] }], rounds: 0, status: 'agreed', positions: { codex: { version: 1, position: 'accept', reason: 'Agreed' }, claude: { version: 1, position: 'accept', reason: 'Agreed' } } }];
  const { controller, codex, claude, workspaces } = setup(session);
  Object.assign(workspaces, { prepare: vi.fn(async (_s: Session, id: string) => ({ cwd: '/tmp/worktree', writable: id === 'codex' })), finalize: vi.fn(async () => 'commit'), merge: vi.fn(async () => ({ path: '/tmp/candidate', conflicts: false })) });
  codex.automatic = call => call.resolve({ message: 'Implemented', actions: [{ type: 'complete_task', id: 'component', summary: 'Implemented' }] });
  await controller.send('Complete and discuss the authorized component', 'both'); await controller.wait();
  expect(claude.calls).toHaveLength(1);
  expect(claude.calls[0]!.turn.signal.aborted).toBe(true);
  expect(controller.getView().session.pendingRecipients).toEqual(['claude']);
  await controller.acceptIntegration('Combined tests pass');
  expect(controller.getView().session).toMatchObject({ status: 'paused', pendingRecipients: ['claude'] });
  claude.automatic = call => call.resolve(emptyReply('Review response'));
  await controller.start(); await controller.wait();
  expect(codex.calls).toHaveLength(1); expect(claude.calls).toHaveLength(2);
  expect(controller.getView().session).toMatchObject({ awaitingInput: true, pendingRecipients: [] });
});
