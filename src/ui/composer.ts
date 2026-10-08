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
  // Highlight the existing grapheme. Only an empty line/end needs a blank cell;
  // inserting a cursor glyph in the middle would shift text and soft wraps.
  const blank = cursor === draft.length || draft[cursor] === '\n';
  const text = `› ${draft.slice(0, cursor)}${blank ? ' ' : ''}${draft.slice(cursor)}`;
  const rows = wrapRows(text, width);
  const caret = cursor + 2;
  const caretRow = rows.findLastIndex(row => row.offset <= caret);
  const count = Math.min(Math.max(1, maxRows), rows.length);
  const start = Math.max(0, Math.min(caretRow - count + 1, rows.length - count));
  const visible = rows.slice(start, start + count);
  const rendered = visible.map(row => row.text).join('\n');
  const offset = visible.slice(0, caretRow - start).reduce((total, row) => total + row.text.length + 1, 0) + caret - rows[caretRow].offset;
  const length = blank ? 1 : nextCursor(draft, cursor) - cursor;
  return { text: rendered, count, before: rendered.slice(0, offset), caret: rendered.slice(offset, offset + length), after: rendered.slice(offset + length) };
}
