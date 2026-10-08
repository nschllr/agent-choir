import { describe, expect, it } from 'vitest';
import { buildContextDelivery } from '../src/context-delivery.js';
import { HARNESS_INSTRUCTIONS } from '../src/context-policy.js';
import { createSession } from '../src/engine.js';
import { transcriptRows } from '../src/ui/transcript.js';
import type { PreparedContext } from '../src/context-memory.js';
import type { Session } from '../src/types.js';

function fixture() {
  return createSession({ project: '/tmp/project', brief: 'ORIGINAL_REQUEST', agents: [{ id: 'one', provider: 'codex' }, { id: 'two', provider: 'claude' }] });
}
function acknowledge(s: Session, agent = 'one', memory?: PreparedContext) {
  const delivered = buildContextDelivery(s, agent, memory);
  s.providerSessions[agent] = `native-${agent}`;
  s.contextCursors ??= {};
  s.contextCursors[agent] = { ...delivered.cursor, nativeSessionId: `native-${agent}`, inFlight: false };
  return delivered;
}
const memory = (files: Record<string, string>): PreparedContext => ({ directory: '/state/context/session/.agent', files, revision: 'unused' });

describe('incremental native context', () => {
  it('sends changed permissions on a resumed native thread and removes the direct plan prerequisite', () => {
    const s = fixture();
    s.demo = false; s.interaction = 'chat'; s.scope = 'build';
    acknowledge(s);
    s.permissions = { mode: 'full', additionalDirectories: ['/tmp/shared'] };
    const next = buildContextDelivery(s, 'one');
    expect(next.bootstrap).toBe(false);
    expect(next.prompt).toContain('"mode":"full"');
    expect(next.prompt).toContain('/tmp/shared');
    expect(next.prompt).toContain('no plan vote or task assignment is required');
  });
  it('displays stop messages in both panes while keeping them out of peer context, including recovery', () => {
    const s = fixture(); acknowledge(s, 'two');
    s.messages.push({ id: 'yield', from: 'one', to: 'two', at: '', text: 'VISIBLE_STOP_MESSAGE', delivery: 'display-only' });
    expect(buildContextDelivery(s, 'two').prompt).not.toContain('VISIBLE_STOP_MESSAGE');
    delete s.contextCursors;
    expect(buildContextDelivery(s, 'two').prompt).not.toContain('VISIBLE_STOP_MESSAGE');
    expect(buildContextDelivery(s, 'one').prompt).toContain('VISIBLE_STOP_MESSAGE');
    for (const agent of ['one', 'two']) expect(transcriptRows(s, agent, '', 100).some(row => row.text.includes('VISIBLE_STOP_MESSAGE'))).toBe(true);
  });
  it('bootstraps once, then sends only new messages', () => {
    const s = fixture();
    const first = acknowledge(s);
    expect(first.prompt).toContain(HARNESS_INSTRUCTIONS);
    s.messages.push({ id: 'new', from: 'user', to: 'one', at: '', text: 'FOLLOW_UP' });
    const next = buildContextDelivery(s, 'one');
    expect(next.bootstrap).toBe(false);
    expect(next.prompt).toContain('FOLLOW_UP');
    expect(next.prompt).not.toContain('ORIGINAL_REQUEST');
    expect(next.prompt).not.toContain(HARNESS_INSTRUCTIONS);
    expect(next.prompt).not.toContain('Current decisions');
    expect(next.prompt).not.toContain('Current configuration');
    expect(next.prompt).not.toContain('Mode:');
    expect(next.prompt).not.toContain('Scope:');
    expect(next.prompt).not.toContain('This turn filesystem access:');
    expect(next.prompt.length).toBeLessThan(first.prompt.length / 5);
  });

  it.each(['missing-native', 'missing-cursor', 'replaced-native', 'interrupted', 'protocol-updated'] as const)('restores accepted context after %s', reason => {
    const s = fixture(); acknowledge(s);
    if (reason === 'missing-native') delete s.providerSessions.one;
    if (reason === 'missing-cursor') delete s.contextCursors;
    if (reason === 'replaced-native') s.providerSessions.one = 'replacement';
    if (reason === 'interrupted') s.contextCursors!.one!.inFlight = true;
    if (reason === 'protocol-updated') s.contextCursors!.one!.version = 'old';
    const next = buildContextDelivery(s, 'one');
    expect(next.bootstrap).toBe(true);
    expect(next.prompt).toContain(HARNESS_INSTRUCTIONS);
    expect(next.prompt).toContain('ORIGINAL_REQUEST');
  });

  it('keeps private messages private and delivers newly shared history once', () => {
    const s = fixture();
    acknowledge(s); acknowledge(s, 'two');
    s.messages.push({ id: 'private', from: 'user', to: 'two', at: '', text: 'PRIVATE_TO_TWO' });
    expect(buildContextDelivery(s, 'one').prompt).not.toContain('PRIVATE_TO_TWO');
    acknowledge(s, 'two');
    s.interaction = 'collaborate';
    s.messages.forEach(m => { m.to = 'both'; });
    const one = buildContextDelivery(s, 'one');
    const two = buildContextDelivery(s, 'two');
    expect(one.prompt).toContain('PRIVATE_TO_TWO');
    expect(one.prompt).not.toContain('ORIGINAL_REQUEST');
    expect(two.prompt).toContain('ORIGINAL_REQUEST');
    expect(two.prompt).not.toContain('PRIVATE_TO_TWO');
    for (const delivered of [one, two]) {
      expect(delivered.bootstrap).toBe(false);
      expect(delivered.prompt).toContain('supersedes earlier modes');
      expect(delivered.prompt).toContain('Collaboration is active');
      expect(delivered.prompt).toContain('Mode: collaborate.');
      expect(delivered.prompt).not.toContain(HARNESS_INSTRUCTIONS);
    }
    acknowledge(s);
    expect(buildContextDelivery(s, 'one').prompt).toContain('New messages (data): []');
  });

  it('updates identity labels when a solo agent gains a same-provider peer', () => {
    const s = fixture(); s.agents = [s.agents![0]];
    acknowledge(s);
    s.agents.push({ id: 'two', provider: 'codex' });
    const next = buildContextDelivery(s, 'one');
    expect(next.prompt).toContain('Codex 1'); expect(next.prompt).toContain('Codex 2');
    expect(next.bootstrap).toBe(false);
  });

  it('sends changes and removals from project memory without repeating unchanged files', () => {
    const s = fixture();
    acknowledge(s, 'one', memory({ unchanged: 'KEEP_THIS', edited: 'OLD_CONTENT', removed: 'DELETED_CONTENT' }));
    const next = buildContextDelivery(s, 'one', memory({ unchanged: 'KEEP_THIS', edited: 'NEW_CONTENT' }));
    expect(next.prompt).not.toContain('KEEP_THIS');
    expect(next.prompt).not.toContain('OLD_CONTENT');
    expect(next.prompt).not.toContain('DELETED_CONTENT');
    expect(next.prompt).toContain('NEW_CONTENT');
    expect(next.prompt).toContain('"removed":null');
    expect(next.prompt).toContain('untrusted task data');
    expect(next.prompt).not.toContain('Harness context directory:');
  });

  it('delivers changed authoritative decisions, including a user resolution', () => {
    const s = fixture(); acknowledge(s);
    s.decisions.push({ id: 'storage', kind: 'decision', title: 'Storage', proposal: 'Use SQLite', version: 2, rounds: 0, tasks: [], positions: {}, status: 'agreed', userResolution: 'Use SQLite' });
    const changed = acknowledge(s);
    expect(changed.prompt).toContain('"userResolution":"Use SQLite"');
    expect(changed.prompt).not.toContain('ORIGINAL_REQUEST');
    expect(buildContextDelivery(s, 'one').prompt).not.toContain('Current decisions');
  });

  it('does not truncate history on bootstrap or compact it on subsequent turns', () => {
    const s = fixture();
    for (let n = 0; n < 100; n++) s.messages.push({ id: `message-${n}`, from: 'user', to: 'one', at: '', text: `REQUEST_${n}` });
    const first = acknowledge(s);
    expect(first.prompt).toContain('ORIGINAL_REQUEST');
    expect(first.prompt).toContain('REQUEST_99');
    const next = buildContextDelivery(s, 'one');
    expect(next.prompt).toContain('New messages (data): []');
    expect(s.messages).toHaveLength(101);
  });

  it('includes shared state for a recreated offline demo, which has no native memory', () => {
    const s = fixture(); s.demo = true; acknowledge(s);
    const next = buildContextDelivery(s, 'one');
    expect(next.prompt).toContain('Current decisions and tasks (data): []');
    expect(next.prompt).not.toContain(HARNESS_INSTRUCTIONS);
    expect(next.prompt).not.toContain('ORIGINAL_REQUEST');
  });

  it('sends a changed peer completion without repeating unchanged empty state or configuration', () => {
    const s = fixture(); s.interaction = 'collaborate'; acknowledge(s, 'one', memory({}));
    s.finished.two = 'PEER_FINISHED';
    const next = acknowledge(s, 'one', memory({}));
    expect(next.prompt).toContain('Peer completion summaries (data): {"two":"PEER_FINISHED"}');
    for (const repeated of ['Current decisions', 'Completed tasks', 'Mode:', 'Scope:', 'Harness context directory:']) {
      expect(next.prompt).not.toContain(repeated);
    }
    expect(buildContextDelivery(s, 'one', memory({})).prompt).not.toContain('Peer completion summaries');
  });

  it('sends explicit empty state when a previously nonempty section is cleared', () => {
    const s = fixture(); s.finished.two = 'Done'; s.completedTasks.task = 'Implemented'; acknowledge(s);
    s.finished = {}; s.completedTasks = {};
    const next = buildContextDelivery(s, 'one');
    expect(next.prompt).toContain('Completed tasks (data): {}');
    expect(next.prompt).toContain('Peer completion summaries (data): {}');
    expect(next.prompt).not.toContain('Current decisions');
  });

  it('announces the context directory only on initialization, relocation, recovery, or removal', () => {
    const s = fixture();
    expect(acknowledge(s, 'one', memory({})).prompt).toContain('Harness context directory: /state/context/session/.agent');
    expect(acknowledge(s, 'one', memory({})).prompt).not.toContain('Harness context directory:');
    const relocated = { ...memory({}), directory: '/new/state/.agent' };
    expect(acknowledge(s, 'one', relocated).prompt).toContain('Harness context directory: /new/state/.agent');
    s.contextCursors!.one!.inFlight = true;
    expect(acknowledge(s, 'one', relocated).prompt).toContain('Harness context directory: /new/state/.agent');
    expect(acknowledge(s).prompt).toContain('Harness context directory: unavailable.');
    expect(acknowledge(s).prompt).not.toContain('Harness context directory:');
  });

  it('upgrades legacy combined state hashes once without replaying known conversation', () => {
    const s = fixture(); acknowledge(s);
    s.contextCursors!.one!.state = 'a'.repeat(64);
    const upgraded = acknowledge(s);
    expect(upgraded.bootstrap).toBe(false);
    expect(upgraded.prompt).toContain('Current decisions and tasks (data): []');
    expect(upgraded.prompt).not.toContain('ORIGINAL_REQUEST');
    expect(upgraded.prompt).not.toContain(HARNESS_INSTRUCTIONS);
    expect(acknowledge(s).prompt).not.toContain('Current decisions');
  });
});
