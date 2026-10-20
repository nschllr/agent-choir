import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { SUPERVISOR_SOURCE } from './supervisor.js';

/** Receives native stderr text when the user opted into a diagnostics log. */
export type NativeDiagnostics = (text: string) => void;
export interface ProcessOptions { binary?: string; prefixArgs?: string[]; diagnostics?: NativeDiagnostics }
export interface JsonProcessOptions { jsonDocument?: boolean; diagnostics?: NativeDiagnostics }
export function abortError(): Error { return new DOMException('Agent turn interrupted', 'AbortError'); }
/** Native stderr is dropped unless the user explicitly opted into a diagnostics log: it can contain credentials or private configuration. */
export class JsonProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private stopTimer?: NodeJS.Timeout;
  private exited = false;
  constructor(binary: string, args: string[], cwd: string, onMessage: (message: any) => void, onError: (error: Error) => void, options: JsonProcessOptions = {}) {
    const { jsonDocument = false, diagnostics } = options;
    this.child = spawn(process.execPath, ['-e', SUPERVISOR_SOURCE, binary, JSON.stringify(args)],
      { cwd, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }) as ChildProcessWithoutNullStreams;
    this.child.on('message', (message: any) => {
      if (message?.type === 'spawn_error') onError(new Error(message.code === 'ENOENT'
        ? `${binary} is not installed or not on PATH. Install it and sign in using its native CLI.`
        : `Unable to run native agent (${message.code ?? 'process error'}).`));
    });
    const lines = jsonDocument ? undefined : createInterface({ input: this.child.stdout });
    const receive = (line: string) => {
      if (!line.trim()) return;
      if (line.length > 8 * 1024 * 1024) { onError(new Error('Native agent emitted an oversized protocol message')); return; }
      try { onMessage(JSON.parse(line)); }
      catch { onError(new Error('Native agent protocol mismatch: expected JSON lines')); }
    };
    lines?.on('line', receive);
    if (jsonDocument) {
      let document = '';
      this.child.stdout.on('data', chunk => {
        document += chunk.toString();
        if (document.length > 64 * 1024) { onError(new Error('Native authentication metadata exceeded its limit')); this.stop(); }
      });
      this.child.stdout.on('end', () => receive(document));
    }
    // Drain stderr; retain it only for an explicit opt-in log.
    this.child.stderr.on('data', chunk => diagnostics?.(chunk.toString()));
    this.child.stdin.on('error', () => onError(new Error('Native agent input stream closed unexpectedly')));
    this.child.on('error', (error: NodeJS.ErrnoException) => onError(new Error(error.code === 'ENOENT'
      ? `${binary} is not installed or not on PATH. Install it and sign in using its native CLI.`
      : `Unable to run native agent (${error.code ?? 'process error'}).`)));
    this.closed = new Promise(resolve => this.child.on('close', code => {
      this.exited = true;
      lines?.close();
      if (this.stopTimer) clearTimeout(this.stopTimer);
      if (code !== 0) onError(new Error(`Native agent exited (${code ?? 'signal'}). Check native login and CLI compatibility.`));
      resolve();
    }));
  }
  write(message: unknown): void { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
  stop(): void {
    if (this.exited || this.stopTimer) return;
    const kill = (signal: NodeJS.Signals) => {
      try {
        this.child.kill(signal);
      } catch { /* Already exited. */ }
    };
    kill('SIGTERM');
    this.stopTimer = setTimeout(() => kill('SIGKILL'), 1500);
    this.stopTimer.unref();
  }
}
