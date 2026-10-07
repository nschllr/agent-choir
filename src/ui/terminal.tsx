import React from 'react';
import { render } from 'ink';
import type { UIController } from '../types.js';
import { App } from './App.js';
import { MouseEvents, mouseInput } from './mouse.js';

// An alternate screen fixes the origin for mouse coordinates and restores the shell on exit.
const enter = '\x1b[?1049h\x1b[H\x1b[?1006h\x1b[?1000h';
const leave = '\x1b[?1000l\x1b[?1006l\x1b[?1049l';

export async function runTerminal(controller: UIController, start?: () => Promise<void>): Promise<void> {
  const events = new MouseEvents();
  const input = mouseInput(process.stdin, events);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write(leave);
  };
  process.once('exit', restore);
  process.stdout.write(enter);
  let screen: ReturnType<typeof render> | undefined;
  const terminate = () => screen?.unmount();
  process.once('SIGTERM', terminate);
  process.once('SIGINT', terminate);
  try {
    screen = render(<App controller={controller} mouse={events}/>, { stdin: input.stdin, exitOnCtrlC: false });
    await start?.();
    await screen.waitUntilExit();
  } finally {
    screen?.unmount();
    input.dispose();
    restore();
    process.off('exit', restore);
    process.off('SIGTERM', terminate);
    process.off('SIGINT', terminate);
  }
}
