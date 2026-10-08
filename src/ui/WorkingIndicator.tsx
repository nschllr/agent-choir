import React, { useEffect, useRef, useState } from 'react';
import { Text } from 'ink';
import { terminalText } from './text.js';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Keep animation local so ticking never rebuilds the transcript or composer. */
export function WorkingIndicator({ color, activity, animate }: { color: string; activity?: string; animate: boolean }) {
  const started = useRef(Date.now());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!animate) return;
    const timer = setInterval(() => setFrame(value => value + 1), 120);
    return () => clearInterval(timer);
  }, [animate]);
  const seconds = Math.max(0, Math.floor((Date.now() - started.current) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return <Text wrap="truncate">
    <Text bold color={color}>{frames[frame % frames.length]} Working…</Text>
    <Text dimColor> · {elapsed}{activity ? ` · ${terminalText(activity).replace(/\n/g, ' ')}` : ''}</Text>
  </Text>;
}
