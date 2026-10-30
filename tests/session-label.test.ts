import { describe, expect, it } from 'vitest';
import { createSession } from '../src/engine.js';
import { nativeSessionTitle } from '../src/session-label.js';

describe('native chat titles', () => {
  it('gives both peers matching meaningful titles with distinct instance names', () => {
    const session = createSession({ project: '/projects/search', scope: 'discuss', brief: 'Design search suggestions', agents: [{ id: 'one', provider: 'codex' }, { id: 'two', provider: 'codex' }] });
    expect(nativeSessionTitle(session, 'one')).toBe(`Agent choir · search · Codex 1 · Design search suggestions · ${session.id.slice(0, 8)}`);
    expect(nativeSessionTitle(session, 'two')).toContain('search · Codex 2 · Design search suggestions');
  });
  it('uses user content rather than harness instructions, and stays stable across later briefs', () => {
    const session = createSession({ project: '/projects/editor', scope: 'discuss', brief: 'Later collaboration task' });
    session.messages = [{ id: 'm', from: 'user', to: 'both', at: '', text: 'Improve\nkeyboard navigation' }];
    expect(nativeSessionTitle(session, 'claude')).toContain('Agent choir · editor · Claude · Improve keyboard navigation');
    session.brief = 'Different task';
    expect(nativeSessionTitle(session, 'claude')).not.toContain('Different task');
    session.messages[0].text = '\x1b[31m' + '😀'.repeat(100);
    const title = nativeSessionTitle(session, 'claude');
    expect(title).not.toContain('\x1b'); expect(title).toContain('…');
    expect(Array.from(title).length).toBeLessThan(140);
  });
});
