import type { AgentProvider, AgentReply, ProviderEvent, ProviderTurn } from '../types.js';
import { REPLY_SCHEMA, parseReply } from '../protocol.js';
import { abortError, JsonProcess, type ProcessOptions } from './process.js';
import { ReadableReplyStream } from './reply-stream.js';
import { requireClaudeSubscription } from './subscription.js';
import { fallbackCatalog } from '../model-settings.js';

function claudeFailure(details: unknown[], subtype: unknown): Error {
  const text = details.filter((value): value is string => typeof value === 'string').join('\n');
  // Classify native diagnostics without persisting arbitrary output or credentials.
  if (/Failed to refresh OAuth token/i.test(text)) return new Error(
    'Claude could not refresh its subscription login. Another Claude Code process may be refreshing it or may have exited mid-refresh. Retry in a minute; if it persists, close other Claude Code processes and run claude auth login.');
  const reason = typeof subtype === 'string' && /^error_[a-z_]+$/.test(subtype) ? ` (${subtype})` : '';
  return new Error(`Claude turn failed${reason}. Check native login, sandbox availability, and CLI compatibility.`);
}

/** Stream-json print mode of the unmodified Claude Code CLI; no credential handling. */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  private active = new Set<JsonProcess>();
  constructor(private readonly options: ProcessOptions = {}) {}
  async listModels() { return fallbackCatalog('claude'); }
  async run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply> {
    if (turn.signal.aborted) throw abortError();
    await requireClaudeSubscription(turn, this.options, this.active);
    if (turn.signal.aborted) throw abortError();
    let resolveReply!: (reply: AgentReply) => void, rejectReply!: (error: Error) => void;
    const result = new Promise<AgentReply>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const messageStreams = new Map<number, ReadableReplyStream>();
    let nativeError: Error | undefined;
    void result.catch(() => {});
    const full = turn.writable && turn.permissions?.mode === 'full';
    const directories = turn.permissions?.additionalDirectories ?? [];
    // Project writes use sandboxed Bash; full access explicitly permits native file tools.
    const settings = {
      disableAllHooks: true,
      sandbox: { enabled: turn.writable && !full, failIfUnavailable: true, allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true, excludedCommands: [],
        filesystem: { allowWrite: turn.writable ? directories : [] },
        network: { allowedDomains: [], allowAllUnixSockets: false, allowLocalBinding: false },
      },
    };
    const args = [...(this.options.prefixArgs ?? []), '-p', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--json-schema', JSON.stringify(REPLY_SCHEMA),
      '--setting-sources', '', '--settings', JSON.stringify(settings),
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', full ? 'mcp__*,NotebookEdit,Agent' : 'mcp__*,Edit,Write,NotebookEdit,Agent',
      '--tools', full ? 'Read,Glob,Grep,Bash,Edit,Write' : turn.writable ? 'Read,Glob,Grep,Bash' : 'Read,Glob,Grep',
      '--permission-mode', full ? 'bypassPermissions' : 'dontAsk',
    ];
    if (full) args.push('--dangerously-skip-permissions');
    for (const path of directories) args.push('--add-dir', path);
    if (turn.sessionId) args.push('--resume', turn.sessionId);
    if (turn.model) args.push('--model', turn.model);
    if (turn.model === null) args.push('--model', 'default');
    if (turn.effort) args.push('--effort', turn.effort);
    if (turn.title) args.push('--name', turn.title);
    const process = new JsonProcess(this.options.binary ?? 'claude', args, turn.cwd, message => {
      if (typeof message.session_id === 'string') emit({ type: 'session', sessionId: message.session_id });
      if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
        emit({ type: 'activity', text: `Claude model: ${message.model}` });
      }
      if (message.type === 'assistant' && message.isApiErrorMessage === true) {
        const content = message.message?.content;
        nativeError = claudeFailure(Array.isArray(content) ? content.map((block: any) => block?.text) : [], message.error);
      }
      if (message.type === 'stream_event') {
        const event = message.event;
        if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const key = event.index ?? 0;
          const stream = messageStreams.get(key) ?? new ReadableReplyStream(); messageStreams.set(key, stream);
          const text = stream.push(event.delta.text); if (text) emit({ type: 'text', text });
        }
        if (event?.type === 'content_block_start' && event.content_block?.type === 'text') messageStreams.set(event.index ?? 0, new ReadableReplyStream());
        if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          emit({ type: 'activity', text: `Claude: ${event.content_block.name}` }); emit({ type: 'tool_boundary' });
        }
      }
      if (message.type === 'user' && message.message?.content?.some((block: any) => block.type === 'tool_result')) emit({ type: 'tool_boundary' });
      if (message.type === 'result') {
        if (message.is_error || message.subtype !== 'success') {
          rejectReply(nativeError ?? claudeFailure([message.result, ...(Array.isArray(message.errors) ? message.errors : [])], message.subtype)); return;
        }
        try {
          const data = message.structured_output ?? JSON.parse(message.result);
          const reply = parseReply(data); emit({ type: 'reply', reply }); resolveReply(reply);
        } catch { rejectReply(new Error('Claude returned an invalid collaboration response')); }
      }
    }, rejectReply, { diagnostics: this.options.diagnostics });
    this.active.add(process);
    const abort = () => { rejectReply(abortError()); process.stop(); };
    turn.signal.addEventListener('abort', abort, { once: true });
    // Prompt over stdin avoids exposing user/project text in process listings.
    process.child.stdin.end(turn.prompt);
    process.closed.then(() => rejectReply(new Error('Claude exited without a collaboration result')));
    try { return await result; }
    finally {
      turn.signal.removeEventListener('abort', abort); process.stop(); await process.closed; this.active.delete(process);
    }
  }
  async dispose(): Promise<void> { for (const process of this.active) process.stop(); await Promise.all([...this.active].map(process => process.closed)); }
}
