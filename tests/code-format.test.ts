import { describe, expect, it } from 'vitest';
import { highlightCode, inlineSpans } from '../src/ui/code-format.js';

describe('inline code', () => {
  it('removes matching delimiters and styles their contents', () => {
    expect(inlineSpans('Run `npm test` now.')).toEqual([
      { text: 'Run ' }, { text: 'npm test', kind: 'inline' }, { text: ' now.' },
    ]);
  });

  it('allows inner backticks in multi-backtick spans', () => {
    expect(inlineSpans('Use ``a ` b`` then `c`.')).toEqual([
      { text: 'Use ' }, { text: 'a ` b', kind: 'inline' }, { text: ' then ' },
      { text: 'c', kind: 'inline' }, { text: '.' },
    ]);
  });

  it('preserves unmatched runs and requires an exact closing run', () => {
    expect(inlineSpans('Keep `this and ``that')).toEqual([{ text: 'Keep `this and ``that' }]);
    expect(inlineSpans('unmatched `` then `valid`')).toEqual([
      { text: 'unmatched `` then ' }, { text: 'valid', kind: 'inline' },
    ]);
  });

  it('handles long input with many backtick runs and unmatched lengths', () => {
    const unmatched = Array.from({ length: 500 }, (_, index) => '`'.repeat(index + 2) + 'x').join(' ');
    const matched = 'before `value` after '.repeat(10_000);
    expect(inlineSpans(unmatched)).toEqual([{ text: unmatched }]);
    const spans = inlineSpans(matched);
    expect(spans.filter(span => span.kind === 'inline')).toHaveLength(10_000);
    expect(spans.map(span => span.text).join('')).toBe('before value after '.repeat(10_000));
  });
});

describe('code highlighting', () => {
  it('colors tokens without recoloring strings, comments or identifiers containing keywords', () => {
    const source = 'const constant = "return 42 // true"; // let 7\nreturn constant + 12;';
    const spans = highlightCode(source, 'typescript');
    expect(spans.map(span => span.text).join('')).toBe(source);
    expect(spans.filter(span => span.kind === 'keyword').map(span => span.text)).toEqual(['const', 'return']);
    expect(spans.filter(span => span.kind === 'string').map(span => span.text)).toEqual(['"return 42 // true"']);
    expect(spans.filter(span => span.kind === 'comment').map(span => span.text)).toEqual(['// let 7']);
    expect(spans.filter(span => span.kind === 'number').map(span => span.text)).toEqual(['12']);
  });

  it('handles escaped quotes and multiline comments', () => {
    const source = '/* return\n 9 */ const s = "a\\"true";';
    const spans = highlightCode(source, 'js');
    expect(spans.map(span => span.text).join('')).toBe(source);
    expect(spans.find(span => span.kind === 'string')?.text).toBe('"a\\"true"');
    expect(spans.find(span => span.kind === 'comment')?.text).toBe('/* return\n 9 */');
  });

  it.each(['js', 'json', 'python', 'bash', 'cpp', 'sql', 'yaml'])('preserves whitespace and all source text for %s', language => {
    const source = '\tvalue = 1.25e-3;\n  "text"\n\n';
    expect(highlightCode(source, language).map(span => span.text).join('')).toBe(source);
  });

  it('recognizes language-specific comments and SQL case-insensitive keywords', () => {
    expect(highlightCode('SELECT 2 -- FROM 3', 'sql')).toEqual([
      { text: 'SELECT', kind: 'keyword' }, { text: ' ' }, { text: '2', kind: 'number' },
      { text: ' ' }, { text: '-- FROM 3', kind: 'comment' },
    ]);
    expect(highlightCode('if True: # return 3', 'py').filter(span => span.kind)).toEqual([
      { text: 'if', kind: 'keyword' }, { text: 'True', kind: 'literal' }, { text: '# return 3', kind: 'comment' },
    ]);
  });

  it('does not misidentify parts of identifiers as numbers', () => {
    expect(highlightCode('value42 = 123abc + 0xff + 2e3;', 'js').filter(span => span.kind === 'number').map(span => span.text)).toEqual(['0xff', '2e3']);
  });

  it('keeps unknown and plaintext languages uncolored', () => {
    for (const language of ['', 'text', 'unknown', 'constructor', '__proto__']) expect(highlightCode('const x = 1;', language)).toEqual([{ text: 'const x = 1;' }]);
  });

  it('consumes long malformed numeric tokens without styling partial numbers', () => {
    const token = '1'.repeat(100_000) + 'a';
    expect(highlightCode(token, 'js')).toEqual([{ text: token }]);
  });
});
