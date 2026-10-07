import { describe, expect, it } from 'vitest';
import { createSession } from '../src/engine.js';
import { historyStart, transcriptRows, visibleCodeBlocks, wrapRows } from '../src/ui/transcript.js';

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

describe('formatted code in transcripts', () => {
  const fixture = (text: string) => {
    const s = createSession({ project: '/tmp/project', brief: 'Question' });
    s.messages = [{ id: 'code-message', at: '', from: 'codex', to: 'both', text }];
    return s;
  };
  it('styles inline code and previews five source lines without changing the stored message', () => {
    const text = 'Use `answer` here.\n```ts\nconst answer = 42;\n  second\nthird\nfourth\nfifth\nSIXTH_HIDDEN\nSEVENTH_HIDDEN\n```\nExplanation after the code.';
    const s = fixture(text), rows = transcriptRows(s, 'codex', '', 80);
    expect(rows.flatMap(row => row.spans ?? []).some(span => span.kind === 'inline' && span.text === 'answer')).toBe(true);
    expect(rows.flatMap(row => row.spans ?? []).some(span => span.kind === 'keyword' && span.text === 'const')).toBe(true);
    const code = rows.filter(row => row.code?.part === 'line');
    expect(code).toHaveLength(5);
    expect(code[1].text).toBe('│   second');
    expect(rows.map(row => row.text).join('\n')).toContain('+2 lines');
    expect(rows.map(row => row.text).join('\n')).not.toContain('SIXTH_HIDDEN');
    expect(rows.map(row => row.text).join('\n')).toContain('Explanation after the code.');
    expect(s.messages[0].text).toBe(text);
    const expanded = transcriptRows(s, 'codex', '', 80, new Set([code[0].code!.id]));
    expect(expanded.filter(row => row.code?.part === 'line')).toHaveLength(7);
    expect(expanded.map(row => row.text).join('\n')).toContain('SEVENTH_HIDDEN');
  });
  it('counts source lines rather than wrapped screen rows and retains blank code lines', () => {
    const s = fixture('```text\n    LONG_LINE_abcdefghij\n\nthird\nfourth\nfifth\nHIDDEN\n```');
    const rows = transcriptRows(s, 'codex', '', 12);
    expect(rows.filter(row => row.code?.part === 'line').length).toBeGreaterThan(5);
    expect(rows.some(row => row.text === '│ ')).toBe(true);
    expect(rows.every(row => !row.text.includes('HIDDEN'))).toBe(true);
    expect(rows.find(row => row.code)?.code?.lines).toBe(6);
  });
  it('supports tilde fences and does not close a long backtick fence with a shorter one', () => {
    const s = fixture('````md\n```js\nlet x = 1;\n```\n````\n~~~python\nx = 2\n~~~');
    const rows = transcriptRows(s, 'codex', '', 80);
    const headers = rows.filter(row => row.code?.part === 'header');
    expect(headers.map(row => row.code?.language)).toEqual(['md', 'python']);
    expect(headers[0].code?.lines).toBe(3);
    expect(rows.filter(row => row.code?.part === 'line').map(row => row.text)).toContain('│ ```js');
  });
  it('keeps an expanded streaming block stable as lines and the closing fence arrive', () => {
    const s = fixture('Earlier');
    const partial = '```js\n1\n2\n3\n4\n5\n6';
    const before = transcriptRows(s, 'codex', partial, 80);
    const id = before.find(row => row.code)?.code?.id!;
    const after = transcriptRows(s, 'codex', partial + '\n7\n```\nDone', 80, new Set([id]));
    expect(after.find(row => row.code)?.code?.id).toBe(id);
    expect(after.some(row => row.text === '│ 7')).toBe(true);
    expect(after.some(row => row.text === 'Done')).toBe(true);
  });
  it('selects only expandable blocks intersecting the viewport, including partial blocks', () => {
    const s = fixture('```js\n1\n2\n3\n4\n5\n6\n```\nBetween\n```py\n1\n2\n3\n4\n5\n6\n```');
    const rows = transcriptRows(s, 'codex', '', 80);
    const blocks = visibleCodeBlocks(rows, 0, rows.length);
    expect(blocks).toHaveLength(2);
    const body = rows.findIndex(row => row.code?.part === 'line');
    expect(visibleCodeBlocks(rows, body, body + 1).map(block => block.id)).toEqual([blocks[0].id]);
    expect(visibleCodeBlocks(rows, 0, 1)).toEqual([]);
    const narrow = transcriptRows(s, 'codex', '', 8, new Set([blocks[0].id]));
    expect(narrow.find(row => row.code?.id === blocks[0].id)?.code?.expanded).toBe(true);
    expect(narrow.find(row => row.code?.id === blocks[1].id)?.code?.expanded).toBe(false);
  });
  it('sanitizes terminal control sequences before syntax styling and retains unicode across wraps', () => {
    const s = fixture('```js\nconst value = "界👩‍💻é";\x1b[31m\n```');
    const rows = transcriptRows(s, 'codex', '', 12);
    expect(rows.every(row => !row.text.includes('\x1b'))).toBe(true);
    expect(rows.filter(row => row.code?.part === 'line').map(row => row.text.slice(2)).join('')).toContain('界👩‍💻é');
    for (const row of rows) if (row.spans) expect(row.spans.map(span => span.text).join('')).toBe(row.text);
  });
});
