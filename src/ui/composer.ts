import { wrapRows } from './transcript.js';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function previousCursor(text: string, cursor: number): number {
  let previous = 0;
  for (const { index } of graphemes.segment(text)) {
    if (index >= cursor) break;
    previous = index;
  }
  return previous;
}
export function nextCursor(text: string, cursor: number): number {
  for (const { index } of graphemes.segment(text)) if (index > cursor) return index;
  return text.length;
}

/** Soft wraps are display-only; keep a bounded viewport containing the caret. */
export function composerLayout(draft: string, cursor: number, width: number, maxRows = 4) {
  const text = `› ${draft.slice(0, cursor)}▏${draft.slice(cursor)}`;
  const rows = wrapRows(text, width);
  const caret = cursor + 2;
  const caretRow = rows.findLastIndex(row => row.offset <= caret);
  const count = Math.min(Math.max(1, maxRows), rows.length);
  const start = Math.max(0, Math.min(caretRow - count + 1, rows.length - count));
  return { text: rows.slice(start, start + count).map(row => row.text).join('\n'), count };
}
