import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { agentName } from '../agents.js';
import type { AgentId, Session } from '../types.js';
import type { MouseEvents } from './mouse.js';
import { terminalText } from './text.js';
import { wrapRows } from './transcript.js';

export interface CopySnapshot { name: string; source?: string; messages: Array<{ id: string; text: string }> }
export function copySnapshot(session: Session, agent: AgentId, stream: string, source?: string): CopySnapshot {
  const messages = session.messages.filter(m => m.from === agent || m.to === agent || m.to === 'both')
    .map(m => ({ id: m.id, text: `${m.from === 'user' ? 'You' : m.from === 'system' ? 'Session' : agentName(session, m.from)} ›\n${terminalText(m.text)}` }));
  if (stream) messages.push({ id: `stream:${agent}`, text: `${agentName(session, agent)} ›\n${terminalText(stream)}` });
  return { name: agentName(session, agent), source, messages };
}

/** A stable single-column snapshot lets the terminal own drag selection and copying. */
export function CopyView({ snapshot, width, height, mouse }: { snapshot: CopySnapshot; width: number; height: number; mouse?: MouseEvents }) {
  const rows = snapshot.messages.flatMap((message, index) => [
    ...(index ? [{ id: message.id, text: '' }] : []),
    ...wrapRows(message.text, width).map(row => ({ id: message.id, text: row.text })),
  ]);
  if (!rows.length) rows.push({ id: 'empty', text: 'No messages to copy yet.' });
  const count = Math.max(1, height - 3);
  const max = Math.max(0, rows.length - count);
  const [offset, setOffset] = useState(() => {
    const index = rows.findIndex(row => snapshot.source?.startsWith(row.id + ':'));
    return index < 0 ? max : index;
  });
  const start = Math.min(offset, max);
  useEffect(() => {
    mouse?.emit('tracking', false);
    return () => { mouse?.emit('tracking', true); };
  }, [mouse]);
  useInput((_input, key) => {
    let next = start;
    if (key.pageUp) next -= count;
    else if (key.pageDown) next += count;
    else if (key.upArrow) next--;
    else if (key.downArrow) next++;
    else if (key.home) next = 0;
    else if (key.end) next = max;
    else return;
    setOffset(Math.max(0, Math.min(max, next)));
  });
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <Text color="yellow" wrap="truncate">COPY MODE · {snapshot.name} · Esc/Ctrl+Y back</Text>
    <Text dimColor wrap="truncate">Drag to select · use your terminal's Copy shortcut/menu · PgUp/PgDn scroll</Text>
    <Box height={count} flexShrink={0}><Text wrap="truncate">{rows.slice(start, start + count).map(row => row.text).join('\n')}</Text></Box>
    <Text dimColor wrap="truncate">{start + 1}–{Math.min(rows.length, start + count)}/{rows.length} · frozen view · agents may continue in background</Text>
  </Box>;
}
