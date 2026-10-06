import { describe, expect, it } from 'vitest';
import { createSession } from '../src/engine.js';
import { historyStart, transcriptRows, wrapRows } from '../src/ui/transcript.js';

describe('terminal transcript layout', () => {
  it('wraps wide characters and emoji by columns without splitting graphemes', () => {
    expect(wrapRows('界界a', 4).map(row => row.text)).toEqual(['界界', 'a']);
    expect(wrapRows('👩‍💻e\u0301X', 3).map(row => row.text)).toEqual(['👩‍💻e\u0301', 'X']);
    expect(wrapRows('abcd\nef', 4).map(row => row.text)).toEqual(['abcd', 'ef']);
  });
  it('keeps the beginning of a long conversation available and sanitizes styled provider text', () => {
    const session = createSession({ project: '/tmp/project', brief: 'EARLIEST_MESSAGE' });
    session.messages.push({ id: 'long', at: '', from: 'codex', to: 'both', text: 'x'.repeat(85_000) + '\x1b[31mLAST_MESSAGE\x1b[0m' });
    const rows = transcriptRows(session, 'codex', '', 40);
    expect(rows[0]?.text).toContain('EARLIEST_MESSAGE');
    expect(rows.map(row => row.text).join('')).toContain('LAST_MESSAGE');
    expect(rows.every(row => !row.text.includes('\x1b'))).toBe(true);
    expect(historyStart(rows, null, 10)).toBe(rows.length - 10);
  });
  it('anchors history to its message through appended replies and changed widths', () => {
    const session = createSession({ project: '/tmp/project', brief: 'Earlier message '.repeat(12) });
    session.messages.push({ id: 'later', at: '', from: 'codex', to: 'both', text: 'Later reply '.repeat(30) });
    const rows = transcriptRows(session, 'codex', '', 20);
    const row = rows[3]!;
    const anchor = { source: row.source, offset: row.offset, index: 3 };
    const expanded = transcriptRows(session, 'codex', 'Streaming output '.repeat(50), 20);
    expect(expanded[historyStart(expanded, anchor, 5)]).toEqual(row);
    const resized = transcriptRows(session, 'codex', '', 31);
    const selected = resized[historyStart(resized, anchor, 5)]!;
    expect(selected.source).toBe(anchor.source);
    expect(selected.offset).toBeLessThanOrEqual(anchor.offset);
    expect(selected.offset + selected.text.length).toBeGreaterThan(anchor.offset);
  });
});
