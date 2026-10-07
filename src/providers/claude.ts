import type { AgentProvider, AgentReply, ProviderEvent, ProviderTurn } from '../types.js';
import { REPLY_SCHEMA, parseReply } from '../protocol.js';
import { abortError, JsonProcess, type ProcessOptions } from './process.js';
import { ReadableReplyStream } from './reply-stream.js';
import { requireClaudeSubscription } from './subscription.js';

/** Stream-json print mode of the unmodified Claude Code CLI; no credential handling. */
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude' as const;
  private active = new Set<JsonProcess>();
  constructor(private readonly options: ProcessOptions = {}) {}
  async run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply> {
    if (turn.signal.aborted) throw abortError();
    await requireClaudeSubscription(turn, this.options, this.active);
    if (turn.signal.aborted) throw abortError();
    let resolveReply!: (reply: AgentReply) => void, rejectReply!: (error: Error) => void;
    const result = new Promise<AgentReply>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const messageStreams = new Map<number, ReadableReplyStream>();
    void result.catch(() => {});
    // Edit/Write run outside the Bash sandbox. Keep them unavailable even in build
    // mode: writes must use sandboxed Bash, with fallback explicitly prohibited.
    const settings = {
      disableAllHooks: true,
      sandbox: { enabled: turn.writable, failIfUnavailable: true, allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: true, excludedCommands: [],
        network: { allowedDomains: [], allowAllUnixSockets: false, allowLocalBinding: false },
      },
    };
    const args = [...(this.options.prefixArgs ?? []), '-p', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--json-schema', JSON.stringify(REPLY_SCHEMA),
      '--setting-sources', '', '--settings', JSON.stringify(settings),
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disallowedTools', 'mcp__*,Edit,Write,NotebookEdit,Agent',
      '--tools', turn.writable ? 'Read,Glob,Grep,Bash' : 'Read,Glob,Grep',
      '--permission-mode', 'dontAsk',
    ];
    if (turn.sessionId) args.push('--resume', turn.sessionId);
    if (turn.model) args.push('--model', turn.model);
    if (turn.title) args.push('--name', turn.title);
    const process = new JsonProcess(this.options.binary ?? 'claude', args, turn.cwd, message => {
      if (typeof message.session_id === 'string') emit({ type: 'session', sessionId: message.session_id });
      if (message.type === 'system' && message.subtype === 'init' && typeof message.model === 'string') {
        emit({ type: 'activity', text: `Claude model: ${message.model}` });
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
          rejectReply(new Error(`Claude turn failed (${String(message.subtype ?? 'native error')}). Check native login, sandbox availability, and CLI compatibility.`)); return;
        }
        try {
          const data = message.structured_output ?? JSON.parse(message.result);
          const reply = parseReply(data); emit({ type: 'reply', reply }); resolveReply(reply);
        } catch { rejectReply(new Error('Claude returned an invalid collaboration response')); }
      }
    }, rejectReply);
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
