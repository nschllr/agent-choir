import { basename } from 'node:path';
import { agentName } from './agents.js';
import type { AgentId, Session } from './types.js';
import { terminalText } from './ui/text.js';

const shorten = (text: string, limit: number) => {
  const chars = Array.from(terminalText(text).replace(/\s+/g, ' ').trim());
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
};

/** Deterministic native titles, independent of the protocol bootstrap prompt. */
export function nativeSessionTitle(session: Session, agent: AgentId): string {
  const firstTask = session.messages.find(message => message.from === 'user')?.text || session.brief;
  return `Agent duet · ${shorten(basename(session.project), 32) || 'Project'} · ${agentName(session, agent)} · ${shorten(firstTask, 64) || 'New chat'} · ${session.id.slice(0, 8)}`;
}
