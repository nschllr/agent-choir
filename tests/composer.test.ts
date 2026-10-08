import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { composerLayout, nextCursor, previousCursor } from '../src/ui/composer.js';

describe('wrapped composer', () => {
  it('grows for soft wrapping and preserves spaces and explicit newlines', () => {
    const draft = 'first second third\nfourth';
    const layout = composerLayout(draft, draft.length, 12);
    expect(layout).toMatchObject({ text: '› first seco\nnd third\nfourth ', count: 3, caret: ' ' });
    expect(composerLayout('x'.repeat(10), 10, 12).text).toBe('› xxxxxxxxxx\n ');
    expect(composerLayout('first\n', 6, 12).text).toBe('› first\n ');
  });
  it('keeps the cursor visible at either end or the middle of a long draft', () => {
    const draft = 'START ' + 'middle '.repeat(150) + ' END';
    for (const cursor of [0, 100, draft.length]) {
      const layout = composerLayout(draft, cursor, 30);
      expect(layout.count).toBe(4);
      expect(layout.caret.length).toBeGreaterThan(0);
      expect(layout.before + layout.caret + layout.after).toBe(layout.text);
      expect(layout.text.split('\n')).toHaveLength(4);
    }
    expect(composerLayout(draft, 0, 30)).toMatchObject({ before: '› ', caret: 'S' });
    expect(composerLayout(draft, draft.length, 30).text).toContain('END ');
  });
  it('highlights text in place without introducing a gap or changing soft wrapping', () => {
    const draft = 'abcdefghij';
    for (let cursor = 0; cursor < draft.length; cursor++) {
      const layout = composerLayout(draft, cursor, 6);
      expect(layout.text).toBe('› abcd\nefghij');
      expect(layout.caret).toBe(draft[cursor]);
    }
    expect(composerLayout('ab\ncd', 2, 10)).toMatchObject({ before: '› ab', caret: ' ', after: '\ncd' });
    expect(composerLayout('a👩‍💻é漢字', 1, 6)).toMatchObject({ before: '› a', caret: '👩‍💻' });
    expect(composerLayout('a👩‍💻é漢字', 6, 6).caret).toBe('é');
  });
  it('wraps terminal-width graphemes and moves/deletes entire emoji and combining characters', () => {
    const draft = 'a👩‍💻é漢字';
    const layout = composerLayout(draft, draft.length, 6);
    expect(layout.text).toContain('👩‍💻'); expect(layout.text).toContain('é');
    expect(layout.text.split('\n').every(line => stringWidth(line) <= 6)).toBe(true);
    expect(nextCursor(draft, 1)).toBe(6);
    expect(previousCursor(draft, 6)).toBe(1);
    expect(nextCursor(draft, 6)).toBe(8);
    expect(previousCursor(draft, 8)).toBe(6);
  });
});
