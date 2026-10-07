import { describe, expect, it, vi } from 'vitest';
import { MouseDecoder } from '../src/ui/mouse.js';

describe('terminal mouse input', () => {
  it('removes mouse packets while preserving keyboard text and escape sequences', () => {
    const keys: string[] = [], mouse = vi.fn();
    const decoder = new MouseDecoder(text => keys.push(text), mouse);
    decoder.push('draft\x1b[<64;80;6M\x1b[<65;80;6M\x1b[<0;5;8M\x1b[<0;5;8m\x1b[A\r');
    expect(keys.join('')).toBe('draft\x1b[A\r');
    expect(mouse.mock.calls.map(call => call[0])).toEqual([
      { action: 'up', x: 79, y: 5 }, { action: 'down', x: 79, y: 5 }, { action: 'click', x: 4, y: 7 },
    ]);
    decoder.dispose();
  });
  it('handles packets split at every byte boundary without leaking coordinates into the draft', () => {
    const packet = '\x1b[<64;100;20M';
    for (let i = 1; i < packet.length; i++) {
      const keys = vi.fn(), mouse = vi.fn();
      const decoder = new MouseDecoder(keys, mouse);
      decoder.push(packet.slice(0, i)); decoder.push(packet.slice(i));
      expect(mouse).toHaveBeenCalledExactlyOnceWith({ action: 'up', x: 99, y: 19 });
      expect(keys).not.toHaveBeenCalled();
      decoder.dispose();
    }
  });
  it('ignores releases, motion, extra buttons, invalid coordinates and incomplete mouse packets', () => {
    vi.useFakeTimers();
    try {
      const keys = vi.fn(), mouse = vi.fn();
      const decoder = new MouseDecoder(keys, mouse);
      decoder.push('\x1b[<0;1;1m\x1b[<32;1;1M\x1b[<2;1;1M\x1b[<0;0;1M\x1b[<64;99999999999999999;1M');
      decoder.push('\x1b[<64;'); vi.advanceTimersByTime(501);
      expect(mouse).not.toHaveBeenCalled(); expect(keys).not.toHaveBeenCalled();
      decoder.push('\x1b'); vi.advanceTimersByTime(31);
      expect(keys).toHaveBeenCalledExactlyOnceWith('\x1b');
      decoder.dispose();
    } finally { vi.useRealTimers(); }
  });
});
