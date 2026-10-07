import { resolve } from 'node:path';

/** POSIX shell quoting: paths and session data must never become shell syntax. */
export const shellArgument = (text: string) => /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";

export function resumeCommand(stateDir: string, id: string, mode: 'resume' | 'attach', invocation = {
  binary: process.execPath, args: process.execArgv, entry: process.argv[1],
}): string {
  return [invocation.binary, ...invocation.args, resolve(invocation.entry), '--state-dir', resolve(stateDir), `--${mode}`, id].map(shellArgument).join(' ');
}
