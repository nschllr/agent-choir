import stringWidth from 'string-width';
import { agentName } from '../agents.js';
import type { AgentId, Session } from '../types.js';
import { terminalText } from './text.js';

export interface TranscriptRow {
  source: string;
  offset: number;
  text: string;
  from: string;
  prefix?: string;
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

export function transcriptRows(session: Session, agent: AgentId, stream: string, width: number): TranscriptRow[] {
  const messages = session.messages.filter(m => m.from === agent || m.to === agent || m.to === 'both');
  const rows: TranscriptRow[] = [];
  const append = (source: string, from: string, value: string) => {
    const name = from === 'user' ? 'You' : from === 'system' ? 'Session' : agentName(session, from);
    const prefix = `${name} › `;
    if (rows.length) rows.push({ source: `${source}:gap`, from, text: '', offset: 0 });
    for (const row of wrapRows(prefix + value, width)) rows.push({ ...row, source, from, ...(row.offset === 0 ? { prefix } : {}) });
  };
  for (const m of messages) append(m.id, m.from, m.text);
  if (stream) append(`stream:${agent}`, agent, stream);
  if (!rows.length) return wrapRows(`Start a conversation with ${agentName(session, agent)}.`, width).map(row => ({ ...row, source: 'empty', from: 'system' }));
  return rows;
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
