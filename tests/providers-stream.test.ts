import { describe, expect, it } from 'vitest';
import { ReadableReplyStream, ReplyMessageStream } from '../src/providers/reply-stream.js';

describe('readable reply streaming', () => {
  it('streams message characters and decodes split escapes without leaking actions', () => {
    const data = JSON.stringify({ message: 'Hello "peer"\n😀', actions: [{ type: 'finish', summary: 'private' }] });
    const stream = new ReplyMessageStream(); let text = '';
    for (const char of data) text += stream.push(char);
    expect(text).toBe('Hello "peer"\n😀');
  });
  it('handles reordered fields and ignores nested message keys', () => {
    const data = JSON.stringify({ actions: [{ message: 'private', type: 'finish' }], message: 'public' });
    const stream = new ReplyMessageStream();
    expect(stream.push(data)).toBe('public');
    expect(stream.push('')).toBe('');
  });
  it('holds incomplete unicode escapes and surrogate pairs', () => {
    const stream = new ReplyMessageStream();
    expect(stream.push('{"message":"hi \\uD8')).toBe('hi ');
    expect(stream.push('3D')).toBe('');
    expect(stream.push('\\uDE00","actions":[]}')).toBe('😀');
  });
  it('preserves natural commentary and extracts structured Claude content', () => {
    const prose = new ReadableReplyStream(); expect(prose.push(' ')).toBe(''); expect(prose.push('Thinking')).toBe(' Thinking');
    const json = new ReadableReplyStream(); expect(json.push(' ')).toBe('');
    expect(json.push('{"message":"visible","actions":[]}')).toBe('visible');
  });
});
