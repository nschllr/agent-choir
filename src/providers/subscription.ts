import { abortError, JsonProcess, type ProcessOptions } from './process.js';
import type { ProviderTurn } from '../types.js';

const API_ENV = {
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_OSS_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK'],
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_FOUNDRY_API_KEY',
    'ANTHROPIC_FOUNDRY_BASE_URL', 'AWS_BEARER_TOKEN_BEDROCK'],
} as const;
export function requireSubscriptionEnvironment(agent: 'claude' | 'codex'): void {
  const key = API_ENV[agent].find(key => Boolean(process.env[key]?.trim()));
  if (key) throw new Error(`Subscription mode refuses ${key}. Unset it and sign in with the native ${agent} CLI using your subscription.`);
}

/** Query authentication metadata only. No credential files or token values are
 * inspected. Require native claude.ai login rather than guessing token billing. */
export async function requireClaudeSubscription(turn: ProviderTurn, options: ProcessOptions, active: Set<JsonProcess>): Promise<void> {
  requireSubscriptionEnvironment('claude');
  if (turn.signal.aborted) throw abortError();
  let resolve!: () => void, reject!: (error: Error) => void;
  const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => {});
  const process = new JsonProcess(options.binary ?? 'claude', [...(options.prefixArgs ?? []), 'auth', 'status'], turn.cwd, metadata => {
    if (metadata.authMethod === 'claude.ai' && metadata.loggedIn !== false) resolve();
    else reject(new Error('Agent Choir requires a Claude subscription login. Run claude auth login using your Claude subscription; API and alternate-provider authentication are unsupported.'));
  }, reject, { jsonDocument: true, diagnostics: options.diagnostics });
  active.add(process);
  process.child.stdin.end();
  const abort = () => { reject(abortError()); process.stop(); };
  turn.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { reject(new Error('Claude authentication preflight timed out')); process.stop(); }, 15_000);
  void process.closed.then(() => reject(new Error('Claude authentication metadata unavailable. Update Claude Code and sign in using claude auth login.')));
  try { await result; }
  finally { clearTimeout(timer); turn.signal.removeEventListener('abort', abort); process.stop(); await process.closed; active.delete(process); }
}
