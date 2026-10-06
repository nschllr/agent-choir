import { AGENTS, type AgentConfig, type AgentId, type ProviderKind, type Session } from './types.js';

export const isProvider = (value: unknown): value is ProviderKind => value === 'claude' || value === 'codex';
export const validAgentId = (value: unknown): value is AgentId => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(value) && !Object.hasOwn(Object.prototype, value) && !['both', 'user', 'system', 'integration', 'prototype'].includes(value);
export const sessionAgents = (session: Pick<Session, 'agents'>): AgentConfig[] => session.agents ?? AGENTS.map(provider => ({ id: provider, provider }));
export const agentIds = (session: Pick<Session, 'agents'>): AgentId[] => sessionAgents(session).map(agent => agent.id);
export const isCollaborating = (session: Pick<Session, 'agents' | 'interaction'>): boolean => session.interaction === 'collaborate' || (session.interaction === undefined && session.agents === undefined);
export function agentName(session: Pick<Session, 'agents'>, id: AgentId): string {
  const agents = sessionAgents(session), agent = agents.find(item => item.id === id);
  if (!agent) return id;
  const name = agent.provider === 'codex' ? 'Codex' : 'Claude';
  const siblings = agents.filter(item => item.provider === agent.provider);
  return siblings.length > 1 ? `${name} ${siblings.findIndex(item => item.id === id) + 1}` : name;
}
export function validateAgents(agents: AgentConfig[]): void {
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > 2 || agents.some(agent => !agent || !validAgentId(agent.id) || !isProvider(agent.provider)) || new Set(agents.map(agent => agent.id)).size !== agents.length) throw new Error('A session requires one or two distinct agent instances with a supported provider');
}
