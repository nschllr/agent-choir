import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DOMElement } from 'ink';

export interface MouseEvent { x: number; y: number; action: 'click' | 'up' | 'down' }
export class MouseEvents extends EventEmitter<{ mouse: [MouseEvent]; tracking: [boolean] }> {}
export interface PaneHandle { node: DOMElement; scroll: (lines: number) => void; source: () => string }

export function containsMouse(node: DOMElement, event: MouseEvent): boolean {
  let left = 0, top = 0;
  for (let current: DOMElement | undefined = node; current; current = current.parentNode) {
    left += current.yogaNode?.getComputedLeft() ?? 0;
    top += current.yogaNode?.getComputedTop() ?? 0;
  }
  return event.x >= left && event.x < left + (node.yogaNode?.getComputedWidth() ?? 0)
    && event.y >= top && event.y < top + (node.yogaNode?.getComputedHeight() ?? 0);
}

/** Strip SGR mouse reports before Ink parses keyboard input, including split packets. */
export class MouseDecoder {
  private pending = '';
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private keyboard: (text: string) => void, private mouse: (event: MouseEvent) => void) {}

  push(chunk: string): void {
    clearTimeout(this.timer);
    let text = this.pending + chunk;
    this.pending = '';
    while (text) {
      const escape = text.indexOf('\x1b');
      if (escape < 0) { this.keyboard(text); return; }
      if (escape > 0) this.keyboard(text.slice(0, escape));
      text = text.slice(escape);
      const prefix = '\x1b[<';
      if (text.length < prefix.length && prefix.startsWith(text)) {
        this.pending = text;
        // A standalone Escape must still close the picker promptly.
        this.timer = setTimeout(() => { const value = this.pending; this.pending = ''; this.keyboard(value); }, 30);
        this.timer.unref();
        return;
      }
      if (!text.startsWith(prefix)) { this.keyboard('\x1b'); text = text.slice(1); continue; }
      const report = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(text);
      if (report) {
        const button = Number(report[1]), x = Number(report[2]) - 1, y = Number(report[3]) - 1;
        if (report[4] === 'M' && [button, x, y].every(Number.isSafeInteger) && x >= 0 && y >= 0) {
          const code = button & ~28; // Shift, Alt and Ctrl modifiers do not change the action.
          const action = code === 0 ? 'click' : code === 64 ? 'up' : code === 65 ? 'down' : undefined;
          if (action) this.mouse({ x, y, action });
        }
        text = text.slice(report[0].length);
      } else if (/^\x1b\[<[\d;]*$/.test(text) && text.length < 80) {
        this.pending = text;
        this.timer = setTimeout(() => { this.pending = ''; }, 500);
        this.timer.unref();
        return;
      } else {
        // Discard malformed mouse payloads, but retain any following keyboard escape.
        const next = text.indexOf('\x1b', prefix.length);
        text = next < 0 ? '' : text.slice(next);
      }
    }
  }
  dispose(): void { clearTimeout(this.timer); this.pending = ''; }
}

/** Keep the native TTY's raw-mode lifecycle while feeding Ink only keyboard bytes. */
export function mouseInput(source: NodeJS.ReadStream, events: MouseEvents) {
  const input = new PassThrough();
  const decoder = new MouseDecoder(text => input.write(text), event => events.emit('mouse', event));
  const receive = (chunk: string | Buffer) => decoder.push(String(chunk));
  source.setEncoding('utf8');
  source.on('data', receive);
  const tty = Object.assign(input, {
    isTTY: source.isTTY,
    setRawMode: (enabled: boolean) => source.setRawMode(enabled),
    ref: () => source.ref(),
    unref: () => source.unref(),
  });
  return {
    stdin: tty as unknown as NodeJS.ReadStream,
    dispose: () => { source.off('data', receive); decoder.dispose(); input.destroy(); },
  };
}
