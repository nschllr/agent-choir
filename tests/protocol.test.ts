import { describe, expect, it } from 'vitest';
import { parseReply, REPLY_SCHEMA } from '../src/protocol.js';

describe('collaboration envelope', () => {
  it('parses exact structured JSON without interpreting conversational agreement', () => {
    expect(parseReply('{"message":"I agree","actions":[]}')).toEqual({ message: 'I agree', actions: [] });
    expect(REPLY_SCHEMA.additionalProperties).toBe(false);
  });
  it('accepts an explicit no-reply marker only as a standalone action', () => {
    expect(parseReply({ message: 'No reply needed', actions: [{ type: 'yield' }] })).toEqual({ message: 'No reply needed', actions: [{ type: 'yield' }] });
    expect(() => parseReply({ message: '', actions: [{ type: 'yield', summary: 'extra' }] })).toThrow();
    expect(() => parseReply({ message: '', actions: [{ type: 'yield' }, { type: 'finish', summary: 'done' }] })).toThrow('Yield must be the only action');
    expect(() => parseReply({ message: '', actions: [{ type: 'yield' }, { type: 'yield' }] })).toThrow('Yield must be the only action');
  });
  it.each([
    { message: 'hello', actions: [], surprise: true },
    { message: 12, actions: [] },
    { message: 'hello', actions: [{ type: 'position', id: 'plan', version: '1', position: 'accept', reason: 'yes' }] },
    { message: 'hello', actions: [{ type: 'position', id: 'plan', version: 1.5, position: 'accept', reason: 'yes' }] },
    { message: 'hello', actions: [{ type: 'finish', summary: 'done', writable: true }] },
    { message: 'hello', actions: [{ type: 'propose', id: 'plan', kind: 'plan', title: 'test', proposal: 'test', tasks: [{ id: 't', owner: '../root', description: 'test', dependsOn: [] }] }] },
    { message: 'hello', actions: [{ type: 'finish' }] },
    { message: 'hello', actions: [{ type: 'shell', command: 'touch file' }] },
    null, [], '```json\n{}\n```',
  ])('rejects malformed or coercive payload %#', value => expect(() => parseReply(value)).toThrow());
});

it('parses safe instance task IDs and rejects reserved identities', () => {
  const payload = (owner: string) => ({ message: '', actions: [{ type: 'propose', id: 'plan', kind: 'plan', title: 'Plan', proposal: 'Work', tasks: [{ id: 'task', owner, description: 'Work', dependsOn: [] }] }] });
  expect(parseReply(payload('agent-2')).actions[0]).toMatchObject({ tasks: [{ owner: 'agent-2' }] });
  for (const owner of ['both', 'user', 'system', 'integration', '__proto__']) expect(() => parseReply(payload(owner))).toThrow('Invalid task owner');
});
