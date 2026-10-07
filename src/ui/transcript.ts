import stringWidth from 'string-width';
import { agentName } from '../agents.js';
import type { AgentId, Session } from '../types.js';
import { terminalText } from './text.js';
import { highlightCode, inlineSpans, type StyledSpan } from './code-format.js';

export interface CodeBlockRow {
  id: string;
  part: 'header' | 'line' | 'footer';
  language: string;
  lines: number;
  expanded: boolean;
}

export interface TranscriptRow {
  source: string;
  offset: number;
  text: string;
  from: string;
  prefix?: string;
  spans?: StyledSpan[];
  code?: CodeBlockRow;
}
export interface HistoryAnchor { source: string; offset: number; index: number; }
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Wrap by terminal columns, keeping emoji and combining characters intact. */
export function wrapRows(value: string, width: number): Array<{ text: string; offset: number }> {
  const rows: Array<{ text: string; offset: number }> = [];
  let text = '', offset = 0, columns = 0;
  const limit = Math.max(1, width);
  for (const { segment, index } of graphemes.segment(terminalText(value))) {
    if (segment === '\n') {
      rows.push({ text, offset }); text = ''; columns = 0; offset = index + 1;
      continue;
    }
    const size = stringWidth(segment);
    if (text && columns + size > limit) {
      rows.push({ text, offset }); text = ''; columns = 0; offset = index;
    }
    text += segment; columns += size;
  }
  if (text || !rows.length) rows.push({ text, offset });
  return rows;
}

/** Wrap styled text by terminal columns without losing token styles at a wrap. */
function styledRows(spans: StyledSpan[], width: number, preserveLastEmpty = false) {
  const text = spans.map(span => span.text).join('');
  const wrapped = wrapRows(text, width);
  if (preserveLastEmpty && text.endsWith('\n')) wrapped.push({ text: '', offset: text.length });
  let token = 0, tokenStart = 0;
  return wrapped.map(row => {
    while (token < spans.length && tokenStart + spans[token].text.length <= row.offset) tokenStart += spans[token++].text.length;
    const parts: StyledSpan[] = [];
    for (let i = token, start = tokenStart; i < spans.length && start < row.offset + row.text.length; start += spans[i++].text.length) {
      const span = spans[i];
      const value = span.text.slice(Math.max(0, row.offset - start), Math.min(span.text.length, row.offset + row.text.length - start));
      if (value) parts.push({ text: value, kind: span.kind });
    }
    return { ...row, spans: parts };
  });
}

export function transcriptRows(session: Session, agent: AgentId, stream: string, width: number, expanded: ReadonlySet<string> = new Set()): TranscriptRow[] {
  const messages = session.messages.filter(m => m.from === agent || m.to === agent || m.to === 'both');
  const rows: TranscriptRow[] = [];
  const append = (source: string, from: string, value: string) => {
    const name = from === 'user' ? 'You' : from === 'system' ? 'Session' : agentName(session, from);
    const prefix = `${name} › `;
    if (rows.length) rows.push({ source: `${source}:gap`, from, text: '', offset: 0 });
    const clean = terminalText(value).replace(/\r\n?/g, '\n');
    const lines = clean.split('\n');
    const offsets: number[] = []; let at = 0;
    for (const line of lines) { offsets.push(at); at += line.length + 1; }
    let first = true, proseStart = 0;
    const prose = (end: number) => {
      if (end <= proseStart) return;
      const text = lines.slice(proseStart, end).join('\n');
      const spans: StyledSpan[] = [...(first ? [{ text: prefix, kind: 'speaker' as const }] : []), ...inlineSpans(text)];
      for (const row of styledRows(spans, width)) rows.push({ ...row, source: `${source}:prose:${offsets[proseStart]}`, from, ...(first && row.offset === 0 ? { prefix } : {}) });
      first = false;
    };
    for (let i = 0; i < lines.length; i++) {
      const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
      if (!opening || (opening[1][0] === '`' && opening[2].includes('`'))) continue;
      prose(i);
      if (first) {
        for (const row of styledRows([{ text: prefix.trimEnd(), kind: 'speaker' }], width)) rows.push({ ...row, source: `${source}:speaker`, from, prefix });
        first = false;
      }
      let close = i + 1;
      for (; close < lines.length; close++) {
        const ending = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[close]);
        if (ending && ending[1][0] === opening[1][0] && ending[1].length >= opening[1].length) break;
      }
      const body = lines.slice(i + 1, close);
      if (close === lines.length && body.at(-1) === '') body.pop(); // A streaming newline is not another source line yet.
      const id = `${source}:code:${offsets[i]}`, language = opening[2].trim().split(/\s+/)[0].slice(0, 32);
      const isExpanded = expanded.has(id), count = body.length;
      const code = { id, language, lines: count, expanded: isExpanded };
      const header = `┌ ${language || 'code'} · ${count} ${count === 1 ? 'line' : 'lines'}`;
      rows.push({ source: `${id}:header`, offset: 0, from, text: wrapRows(header, width)[0].text, code: { ...code, part: 'header' } });
      const shown = (isExpanded ? body : body.slice(0, 5)).join('\n');
      if (body.length) for (const row of styledRows(highlightCode(shown, language), Math.max(1, width - 2), true)) {
        rows.push({ ...row, source: id, from, text: `│ ${row.text}`, spans: [{ text: '│ ' }, ...row.spans], code: { ...code, part: 'line' } });
      }
      const footer = count > 5 ? isExpanded ? '└ Ctrl+X collapse' : `└ +${count - 5} lines · Ctrl+X expand` : '└';
      rows.push({ source: `${id}:footer`, offset: 0, from, text: wrapRows(footer, width)[0].text, code: { ...code, part: 'footer' } });
      i = close; proseStart = close + 1;
    }
    prose(lines.length);
  };
  for (const m of messages) append(m.id, m.from, m.text);
  if (stream) append(`stream:${agent}`, agent, stream);
  if (!rows.length) return wrapRows(`Start a conversation with ${agentName(session, agent)}.`, width).map(row => ({ ...row, source: 'empty', from: 'system' }));
  return rows;
}

/** Only blocks intersecting the current viewport are keyboard targets. */
export function visibleCodeBlocks(rows: TranscriptRow[], start: number, end: number): CodeBlockRow[] {
  const seen = new Set<string>();
  return rows.slice(start, end).flatMap(row => {
    if (!row.code || row.code.lines <= 5 || seen.has(row.code.id)) return [];
    seen.add(row.code.id); return [row.code];
  });
}

/** Use a content anchor so appending output or resizing doesn't move old history. */
export function historyStart(rows: TranscriptRow[], anchor: HistoryAnchor | null, count: number): number {
  const max = Math.max(0, rows.length - count);
  if (!anchor) return max;
  let index = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.source === anchor.source && (index < 0 || row.offset <= anchor.offset)) index = i;
  }
  return Math.min(max, Math.max(0, index < 0 ? anchor.index : index));
}
