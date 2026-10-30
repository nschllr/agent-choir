import { describe, expect, it } from 'vitest';
import { resumeCommand, shellArgument } from '../src/resume-command.js';

describe('copyable resume commands', () => {
  it('uses the same executable, absolute entry point and state directory', () => {
    expect(resumeCommand('/tmp/choir state', 'session-1', 'resume', { binary: '/usr/bin/node', args: [], entry: '/repo/dist/cli.js' }))
      .toBe("/usr/bin/node /repo/dist/cli.js --state-dir '/tmp/choir state' --resume session-1");
  });
  it('retains development loaders and uses attach for a live worker', () => {
    expect(resumeCommand('/tmp/state', 'session-1', 'attach', { binary: '/usr/bin/node', args: ['--import', '/repo/node_modules/tsx/dist/loader.mjs'], entry: '/repo/src/cli.tsx' }))
      .toBe('/usr/bin/node --import /repo/node_modules/tsx/dist/loader.mjs /repo/src/cli.tsx --state-dir /tmp/state --attach session-1');
  });
  it('quotes shell metacharacters as literal path data', () => {
    expect(shellArgument("/tmp/Jack's $(value) `name`")) .toBe("'/tmp/Jack'\\''s $(value) `name`'");
    expect(shellArgument('')).toBe("''");
  });
});
