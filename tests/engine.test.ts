import { describe, expect, it } from 'vitest';
import { applyReply, buildPrompt, canImplement, createSession, resolveDecision } from '../src/engine.js';
import type { AgentId, CollaborationAction, Position, Scope, Session, TaskSpec } from '../src/types.js';

const create = (scope: Scope = 'build') => createSession({ project: '/tmp/example', brief: 'Create a greeting', scope });
const apply = (s: Session, who: AgentId, ...actions: CollaborationAction[]) => applyReply(s, who, { message: 'discussion', actions });
const propose = (s: Session, tasks: TaskSpec[] = []) => apply(s, 'claude', { type: 'propose', id: 'plan', kind: 'plan', title: 'Plan', proposal: 'Build a greeting', tasks });
const vote = (s: Session, who: AgentId, position: Position = 'accept', version = s.decisions[0].version) => apply(s, who, { type: 'position', id: 'plan', version, position, reason: 'Reasons and evidence' });
const agree = (s: Session) => vote(vote(propose(s), 'claude'), 'codex');

describe('versioned peer decisions', () => {
  it('requires both explicit votes and preserves the input session', () => {
    const base = create();
    const s = propose(base);
    expect(base.decisions).toEqual([]);
    expect(canImplement(s)).toBe(false);
    expect(s.decisions[0].positions).toEqual({});
    const one = vote(s, 'claude');
    expect(canImplement(one)).toBe(false);
    const both = vote(one, 'codex');
    expect(canImplement(both)).toBe(true);
    expect(canImplement({ ...both, scope: 'plan' })).toBe(false);
    expect(s.decisions[0].positions).toEqual({});
  });
  it('revisions clear votes and stale or unknown positions reject atomically', () => {
    const s = propose(vote(propose(create()), 'claude'));
    expect(s.decisions[0].version).toBe(2);
    expect(s.decisions[0].positions).toEqual({});
    const before = structuredClone(s);
    expect(() => vote(s, 'codex', 'accept', 1)).toThrow(/stale/);
    expect(() => apply(s, 'codex', { type: 'position', id: 'missing', version: 1, position: 'accept', reason: 'yes' })).toThrow();
    expect(s).toEqual(before);
  });
  it('escalates only after initial unresolved cycle and two resolution cycles', () => {
    let s = propose(create());
    for (let cycle = 1; cycle <= 3; cycle++) {
      s = vote(vote(s, 'claude', 'accept'), 'codex', 'object');
      expect(s.decisions[0].rounds).toBe(cycle);
      expect(s.decisions[0].status).toBe(cycle < 3 ? 'open' : 'waiting_user');
    }
    expect(s.status).toBe('waiting_user');
    expect(() => propose(s)).toThrow();
    expect(() => vote(s, 'codex')).toThrow();
    const resolved = resolveDecision(s, 'plan', 'Proceed with the local implementation');
    expect(resolved.decisions[0].status).toBe('open');
    expect(resolved.decisions[0].userResolution).toContain('Proceed');
    expect(resolved.decisions[0].version).toBe(2);
    expect(resolved.status).toBe('paused');
    expect(canImplement(resolved)).toBe(false);
    expect(resolved.decisions[0].needsRevision).toBe(true);
    expect(() => vote(resolved, 'claude')).toThrow(/revised plan/);
    const revised = propose(resolved);
    expect(revised.decisions[0].needsRevision).toBeUndefined();
    expect(revised.decisions[0].userResolution).toContain('Proceed');
    expect(canImplement(vote(vote(revised, 'claude'), 'codex'))).toBe(true);
    expect(s.decisions[0].status).toBe('waiting_user');
  });
  it('evidence is unresolved and revisions cannot erase partial objections', () => {
    let s = propose(create());
    for (let cycle = 1; cycle <= 3; cycle++) {
      s = vote(s, 'codex', 'evidence');
      s = propose(s);
      expect(s.decisions[0].rounds).toBe(cycle);
    }
    expect(s.status).toBe('waiting_user');
  });
  it('rejects duplicate votes within a cycle and multi-action failures are atomic', () => {
    const s = vote(propose(create()), 'claude');
    expect(() => vote(s, 'claude')).toThrow(/already/);
    const before = structuredClone(s);
    expect(() => apply(s, 'codex', { type: 'position', id: 'plan', version: 1, position: 'accept', reason: 'yes' }, { type: 'complete_task', id: 'missing', summary: 'done' })).toThrow();
    expect(s).toEqual(before);
  });
  it('does not authorize obsolete tasks when the user chooses a different plan', () => {
    let s = propose(create(), [{ id: 'old', owner: 'claude', description: 'Old architecture', dependsOn: [] }]);
    for (let i = 0; i < 3; i++) s = vote(vote(s, 'claude', 'object'), 'codex', 'evidence');
    s = resolveDecision(s, 'plan', 'Use a different architecture');
    expect(s.decisions[0].tasks).toEqual([]);
    expect(s.decisions[0].rounds).toBe(0);
    expect(() => apply(s, 'claude', { type: 'complete_task', id: 'old', summary: 'done' })).toThrow(/not been authorized/);
    s = propose(s, [{ id: 'replacement', owner: 'codex', description: 'Different architecture', dependsOn: [] }]);
    expect(s.decisions[0].userResolution).toBe('Use a different architecture');
    expect(canImplement(s)).toBe(false);
    s = vote(vote(s, 'claude'), 'codex');
    expect(canImplement(s)).toBe(true);
    expect(s.decisions[0].tasks[0].id).toBe('replacement');
  });
  it('preserves the user final word on ordinary resolved decisions', () => {
    const s = create('discuss');
    s.decisions = [{ id: 'storage', kind: 'decision', title: 'Storage', proposal: 'Remote', version: 1, tasks: [], positions: {}, rounds: 3, status: 'waiting_user' }];
    const resolved = resolveDecision(s, 'storage', 'Use local SQLite');
    expect(resolved.decisions[0].status).toBe('agreed');
    expect(() => apply(resolved, 'claude', { type: 'propose', id: 'storage', kind: 'decision', title: 'Storage', proposal: 'Remote again', tasks: [] })).toThrow(/Cannot revise/);
    expect(buildPrompt(resolved, 'claude')).toContain('User resolutions are binding');
  });
});

describe('scope and task completion', () => {
  it.each(['discuss', 'build'] as const)('allows discussion in %s to finish without a plan but requires both agents', scope => {
    const s = apply(create(scope), 'claude', { type: 'finish', summary: 'Recommendation' });
    expect(s.status).not.toBe('complete');
    const end = apply(s, 'codex', { type: 'finish', summary: 'Agreed conclusion' });
    expect(end.status).toBe('complete');
    expect(() => apply(end, 'claude')).toThrow();
  });
  it('defaults to edits enabled without authorizing implementation before agreement', () => {
    const s = createSession({ project: '/tmp/project', brief: 'Let us brainstorm' });
    expect(s.scope).toBe('build');
    expect(canImplement(s)).toBe(false);
    expect(buildPrompt(s, 'codex')).toContain('permission to edit is not a request to implement');
    expect(() => apply(s, 'codex', { type: 'complete_task', id: 'invented', summary: 'Done' })).toThrow('not been authorized');
    const readOnly = agree(create('discuss'));
    expect(canImplement(readOnly)).toBe(false);
    expect(buildPrompt(readOnly, 'codex')).toContain('Project files are read-only');
    expect(createSession({ project: '/tmp/project', brief: 'Offline example', demo: true }).scope).toBe('discuss');
  });
  it('blocks premature completion and respects ownership and dependencies', () => {
    const tasks: TaskSpec[] = [
      { id: 'a', owner: 'claude', description: 'Implement', dependsOn: [] },
      { id: 'b', owner: 'codex', description: 'Verify integration', dependsOn: ['a'] },
    ];
    expect(() => apply(create('plan'), 'claude', { type: 'finish', summary: 'done' })).toThrow();
    let s = vote(vote(propose(create(), tasks), 'claude'), 'codex');
    expect(() => apply(s, 'claude', { type: 'finish', summary: 'done' })).toThrow(/incomplete tasks/);
    expect(() => apply(s, 'codex', { type: 'complete_task', id: 'b', summary: 'done' })).toThrow(/dependencies/);
    expect(() => apply(s, 'codex', { type: 'complete_task', id: 'a', summary: 'done' })).toThrow(/owner/);
    s = apply(s, 'claude', { type: 'complete_task', id: 'a', summary: 'tests passed' });
    s = apply(s, 'codex', { type: 'complete_task', id: 'b', summary: 'integration passed' });
    s = apply(s, 'claude', { type: 'finish', summary: 'done' });
    s = apply(s, 'codex', { type: 'finish', summary: 'done' });
    expect(s.status).toBe('complete');
  });
  it.each([
    [{ id: 'a', owner: 'claude', description: 'a', dependsOn: ['unknown'] }],
    [{ id: 'a', owner: 'claude', description: 'a', dependsOn: ['a'] }],
    [{ id: 'a', owner: 'claude', description: 'a', dependsOn: ['b'] }, { id: 'b', owner: 'codex', description: 'b', dependsOn: ['a'] }],
    [{ id: 'a', owner: 'claude', description: 'a', dependsOn: [] }, { id: 'a', owner: 'codex', description: 'b', dependsOn: [] }],
  ])('rejects malformed task graphs %#', tasks => expect(() => propose(create(), tasks as TaskSpec[])).toThrow());
  it('includes only conversation addressed to this agent or sent by it', () => {
    const s = create('discuss');
    s.messages.push({ id: 'private', at: s.createdAt, from: 'user', to: 'codex', text: 'PRIVATE_CODEX_ONLY' });
    expect(buildPrompt(s, 'claude')).not.toContain('PRIVATE_CODEX_ONLY');
    expect(buildPrompt(s, 'codex')).toContain('PRIVATE_CODEX_ONLY');
    expect(buildPrompt(s, 'claude')).toContain('untrusted task data');
  });
  it('validates runtime session configuration', () => {
    expect(() => createSession({ project: '/tmp/test', brief: 'hello', scope: 'discuss', maxTurns: 1.5 })).toThrow();
    expect(() => createSession({ project: '/tmp/test', brief: 'hello', scope: 'discuss', maxMinutes: NaN })).toThrow();
    expect(canImplement(create())).toBe(false);
  });
});

describe('agent instance rosters', () => {
  const agents = [{ id: 'agent-1', provider: 'codex' as const }, { id: 'agent-2', provider: 'codex' as const }];
  it.each(['toString', 'valueOf', 'hasOwnProperty', '__proto__'])('rejects inherited object key %s as an instance identity', id => {
    expect(() => createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents: [{ id, provider: 'codex' }] })).toThrow();
  });
  it('starts an empty single-agent composer without fabricating a user message', () => {
    const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents: agents.slice(0, 1) });
    expect(s.messages).toEqual([]);
    expect(s.awaitingInput).toBe(true);
    expect(s.agents).toEqual(agents.slice(0, 1));
    expect(buildPrompt(s, 'agent-1')).toContain('only active agent');
    expect(() => createSession({ project: '/tmp/project', scope: 'discuss', brief: '' })).toThrow();
    expect(apply(s, 'agent-1', { type: 'finish', summary: 'Answered' }).status).toBe('complete');
  });
  it('requires separate exact-version votes and finishes from two instances of one provider', () => {
    let s = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Discuss', agents, interaction: 'collaborate' });
    s = apply(s, 'agent-1', { type: 'propose', id: 'choice', kind: 'decision', title: 'Choice', proposal: 'Local', tasks: [] });
    const position = { type: 'position' as const, id: 'choice', version: 1, position: 'accept' as const, reason: 'Fits' };
    s = apply(s, 'agent-1', position);
    expect(s.decisions[0].status).toBe('open');
    expect(() => apply(s, 'codex', position)).toThrow('Unknown agent');
    s = apply(s, 'agent-2', position);
    expect(s.decisions[0].status).toBe('agreed');
    expect(s.messages.at(-1)?.to).toBe('agent-1');
    s = apply(s, 'agent-1', { type: 'finish', summary: 'Done' });
    expect(s.status).not.toBe('complete');
    s = apply(s, 'agent-2', { type: 'finish', summary: 'Done' });
    expect(s.status).toBe('complete');
    expect(buildPrompt(s, 'agent-2')).toContain('Codex 2 (instance ID: agent-2)');
  });
  it('rejects task owners outside the roster, even if their provider is present', () => {
    const s = createSession({ project: '/tmp/project', scope: 'build', brief: 'Build', agents });
    const action = { type: 'propose' as const, id: 'plan', kind: 'plan' as const, title: 'Plan', proposal: 'Implement', tasks: [{ id: 'task', owner: 'codex', description: 'Work', dependsOn: [] }] };
    expect(() => apply(s, 'agent-1', action)).toThrow('Unknown task owner');
    expect(apply(s, 'agent-1', { ...action, tasks: [{ ...action.tasks[0], owner: 'agent-2' }] }).decisions[0].tasks[0].owner).toBe('agent-2');
  });
  it('shares existing conversation with a newly added peer', () => {
    const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Earlier question', agents: agents.slice(0, 1) });
    s.messages.push({ id: 'answer', at: s.createdAt, from: 'agent-1', to: 'both', text: 'Earlier investigation' });
    s.agents = agents;
    s.interaction = 'collaborate';
    expect(buildPrompt(s, 'agent-2')).toContain('Earlier investigation');
    expect(buildPrompt(s, 'agent-2')).toContain('do not pretend to have independently investigated');
  });
});

describe('direct chat isolation', () => {
  const agents = [{ id: 'one', provider: 'codex' as const }, { id: 'two', provider: 'claude' as const }];
  it('queues a startup brief only for the first agent', () => {
    const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'PRIVATE_FIRST_GREETING', agents });
    expect(s.interaction).toBe('chat');
    expect(s.messages[0].to).toBe('one');
    expect(s.pendingRecipients).toEqual(['one']);
    expect(buildPrompt(s, 'two')).not.toContain('PRIVATE_FIRST_GREETING');
    const empty = createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents });
    expect(empty.pendingRecipients).toEqual([]);
    expect(empty.awaitingInput).toBe(true);
  });
  it('keeps a direct answer out of the unaddressed agent conversation', () => {
    const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Hi', agents });
    const answered = applyReply(s, 'one', { message: 'PRIVATE_USER_ANSWER', actions: [] });
    expect(answered.messages.at(-1)?.to).toBe('one');
    expect(buildPrompt(answered, 'one')).toContain('PRIVATE_USER_ANSWER');
    expect(buildPrompt(answered, 'two')).not.toContain('PRIVATE_USER_ANSWER');
    expect(buildPrompt(answered, 'one')).toContain('Answer the USER once');
    expect(buildPrompt(answered, 'one')).toContain('without inventing a task or inspecting project files');
    expect(buildPrompt(answered, 'one')).toContain('no finish action or peer quorum is required');
    expect(answered.finished).toEqual({});
  });
  it('forwards answers only when collaboration is explicitly enabled', () => {
    const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Discuss together', agents, interaction: 'collaborate' });
    expect(s.messages[0].to).toBe('both');
    const answered = applyReply(s, 'one', { message: 'PEER_PROPOSAL', actions: [] });
    expect(answered.messages.at(-1)?.to).toBe('two');
    expect(buildPrompt(answered, 'two')).toContain('PEER_PROPOSAL');
    expect(buildPrompt(answered, 'two')).toContain('equal peer');
    expect(() => createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Hi', agents, interaction: 'invalid' as 'chat' })).toThrow('Invalid interaction mode');
  });
});

it('keeps a first directed message out of the other instance brief and transcript', () => {
  const s = createSession({ project: '/tmp/project', scope: 'discuss', brief: '', agents: [{ id: 'agent-1', provider: 'codex' }, { id: 'agent-2', provider: 'claude' }] });
  s.brief = 'FIRST_DIRECTED_MESSAGE_BODY';
  s.messages.push({ id: 'first', at: s.createdAt, from: 'user', to: 'agent-1', text: s.brief });
  expect(buildPrompt(s, 'agent-1')).toContain('FIRST_DIRECTED_MESSAGE_BODY');
  expect(buildPrompt(s, 'agent-2')).not.toContain('FIRST_DIRECTED_MESSAGE_BODY');
  expect(buildPrompt(s, 'agent-2')).toContain('Accepted conversation for initialization/recovery (data): []');
  s.messages[0].to = 'both';
  expect(buildPrompt(s, 'agent-2')).toContain('FIRST_DIRECTED_MESSAGE_BODY');
});
