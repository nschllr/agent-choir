import { validAgentId } from './agents.js';
import type { AgentReply, CollaborationAction, TaskSpec } from './types.js';

const str = { type: 'string' };
const taskSchema = { type: 'object', additionalProperties: false,
  properties: { id: str, owner: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$' }, description: str, dependsOn: { type: 'array', items: str } },
  required: ['id', 'owner', 'description', 'dependsOn'] };
const action = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
/** Strict structured-output schema: each action variant contains only its own fields. */
export const REPLY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { message: str, actions: { type: 'array', items: { anyOf: [
    action({ type: { type: 'string', enum: ['propose'] }, id: str, kind: { type: 'string', enum: ['plan', 'decision'] }, title: str, proposal: str, tasks: { type: 'array', items: taskSchema } }),
    action({ type: { type: 'string', enum: ['position'] }, id: str, version: { type: 'integer', minimum: 1 }, position: { type: 'string', enum: ['accept', 'object', 'evidence'] }, reason: str }),
    action({ type: { type: 'string', enum: ['complete_task'] }, id: str, summary: str }),
    action({ type: { type: 'string', enum: ['finish'] }, summary: str }),
    action({ type: { type: 'string', enum: ['yield'] } }),
    action({ type: { type: 'string', enum: ['integration_report'] }, outcome: { type: 'string', enum: ['ready', 'accept', 'changes_requested', 'consult', 'advice', 'blocked'] }, revision: str, summary: str }),
  ] } } }, required: ['message', 'actions'],
} as const;

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== fields.length || fields.some(k => !Object.hasOwn(obj, k)) || Object.keys(obj).some(k => !fields.includes(k))) throw new Error(`Expected exactly: ${fields.join(', ')}`);
  return obj;
}
function string(value: unknown, label: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 100_000) throw new Error(`Invalid ${label}`);
  return value;
}
function id(value: unknown): string {
  const result = string(value, 'id');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(result)) throw new Error('Invalid id');
  return result;
}
function task(value: unknown): TaskSpec {
  const v = object(value, ['id', 'owner', 'description', 'dependsOn']);
  if (!validAgentId(v.owner)) throw new Error('Invalid task owner');
  if (!Array.isArray(v.dependsOn) || v.dependsOn.length > 100) throw new Error('Invalid dependencies');
  return { id: id(v.id), owner: v.owner, description: string(v.description, 'description'), dependsOn: v.dependsOn.map(id) };
}
function parseAction(value: unknown): CollaborationAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid action');
  const type = (value as Record<string, unknown>).type;
  if (type === 'yield') { object(value, ['type']); return { type }; }
  if (type === 'integration_report') {
    const v = object(value, ['type', 'outcome', 'revision', 'summary']);
    if (!['ready', 'accept', 'changes_requested', 'consult', 'advice', 'blocked'].includes(v.outcome as string)) throw new Error('Invalid integration outcome');
    const revision = string(v.revision, 'revision', true);
    if (revision && !/^[0-9a-f]{40,64}$/.test(revision)) throw new Error('Invalid integration revision');
    return { type, outcome: v.outcome as import('./types.js').IntegrationOutcome, revision, summary: string(v.summary, 'integration evidence') };
  }
  if (type === 'propose') {
    const v = object(value, ['type', 'id', 'kind', 'title', 'proposal', 'tasks']);
    if (v.kind !== 'plan' && v.kind !== 'decision') throw new Error('Invalid decision kind');
    if (!Array.isArray(v.tasks) || v.tasks.length > 100) throw new Error('Invalid tasks');
    return { type, id: id(v.id), kind: v.kind, title: string(v.title, 'title'), proposal: string(v.proposal, 'proposal'), tasks: v.tasks.map(task) };
  }
  if (type === 'position') {
    const v = object(value, ['type', 'id', 'version', 'position', 'reason']);
    if (!Number.isSafeInteger(v.version) || (v.version as number) < 1) throw new Error('Invalid version');
    if (v.position !== 'accept' && v.position !== 'object' && v.position !== 'evidence') throw new Error('Invalid position');
    return { type, id: id(v.id), version: v.version as number, position: v.position, reason: string(v.reason, 'reason') };
  }
  if (type === 'complete_task') {
    const v = object(value, ['type', 'id', 'summary']);
    return { type, id: id(v.id), summary: string(v.summary, 'summary') };
  }
  if (type === 'finish') {
    const v = object(value, ['type', 'summary']);
    return { type, summary: string(v.summary, 'summary') };
  }
  throw new Error('Unknown action type');
}
export function parseReply(input: unknown | string): AgentReply {
  const v = object(typeof input === 'string' ? JSON.parse(input) : input, ['message', 'actions']);
  if (!Array.isArray(v.actions) || v.actions.length > 100) throw new Error('Invalid actions');
  const actions = v.actions.map(parseAction);
  if (actions.some(a => a.type === 'yield') && actions.length !== 1) throw new Error('Yield must be the only action');
  return { message: string(v.message, 'message', true), actions };
}
