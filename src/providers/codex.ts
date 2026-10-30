import type { AgentProvider, AgentReply, ProviderEvent, ProviderTurn } from '../types.js';
import { REPLY_SCHEMA, parseReply } from '../protocol.js';
import { abortError, JsonProcess, type ProcessOptions } from './process.js';
import { ReplyMessageStream } from './reply-stream.js';
import { requireSubscriptionEnvironment } from './subscription.js';
import { codexModelCatalog, parseCodexModels } from './codex-models.js';

// All are recognized by the locally generated app-server version. External
// automation/browser tools do not inherit the shell filesystem boundary.
const DISABLED_FEATURES = ['hooks', 'plugins', 'apps', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'multi_agent_v2'];

/** App-server v2 JSON-lines protocol; native Codex owns credentials and session storage. */
export class CodexProvider implements AgentProvider {
  readonly id = 'codex' as const;
  private active = new Set<JsonProcess>();
  constructor(private readonly options: ProcessOptions = {}) {}
  async listModels(cwd: string) { requireSubscriptionEnvironment('codex'); return codexModelCatalog(cwd, this.options, this.active); }
  async run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply> {
    if (turn.signal.aborted) throw abortError();
    requireSubscriptionEnvironment('codex');
    let resolveReply!: (reply: AgentReply) => void, rejectReply!: (error: Error) => void;
    const result = new Promise<AgentReply>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let sequence = 0, threadId = '', finalText = '', turnId = '';
    const messageStreams = new Map<string, ReplyMessageStream>();
    const commentary = new Set<string>();
    const fail = (error: Error) => {
      rejectReply(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
    };
    const process = new JsonProcess(this.options.binary ?? 'codex', [...(this.options.prefixArgs ?? []), 'app-server', '--listen', 'stdio://',
      ...DISABLED_FEATURES.flatMap(feature => ['--disable', feature])], turn.cwd, message => {
      if ('id' in message && !message.method) {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error(`Codex app-server request failed (${message.error.code ?? 'protocol error'}). Check native login and protocol compatibility.`));
        else request.resolve(message.result);
        return;
      }
      if ('id' in message && message.method) {
        // Never silently authorize approvals, dynamic tools, or unexpected interactive requests.
        process.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unavailable in Agent Choir' } });
        fail(new Error(`Codex requested unsupported interaction: ${String(message.method)}`)); return;
      }
      const p = message.params ?? {};
      if (p.threadId && threadId && p.threadId !== threadId) return;
      if (message.method === 'item/started' && p.item?.type === 'agentMessage' && p.item.phase === 'commentary') commentary.add(p.item.id);
      if (message.method === 'item/agentMessage/delta') {
        const key = p.itemId ?? '';
        let text: string;
        if (commentary.has(key)) text = p.delta ?? '';
        else {
          const stream = messageStreams.get(key) ?? new ReplyMessageStream(); messageStreams.set(key, stream);
          text = stream.push(p.delta ?? '');
        }
        if (text) emit({ type: 'text', text });
      }
      if (message.method === 'item/started' && !['agentMessage', 'userMessage', 'reasoning'].includes(p.item?.type)) {
        emit({ type: 'activity', text: `Codex: ${p.item?.type ?? 'tool'}` }); emit({ type: 'tool_boundary' });
      }
      if (message.method === 'item/completed') {
        if (p.item?.type === 'agentMessage' && p.item.phase !== 'commentary') finalText = p.item.text;
        else emit({ type: 'tool_boundary' });
      }
      if (message.method === 'turn/completed') {
        if (turnId && p.turn?.id !== turnId) return;
        if (p.turn?.status !== 'completed') fail(new Error(`Codex turn ${p.turn?.status ?? 'failed'}`));
        else {
          try {
            const reply = parseReply(JSON.parse(finalText)); emit({ type: 'reply', reply }); resolveReply(reply);
          } catch { fail(new Error('Codex returned an invalid collaboration response')); }
        }
      }
      if (message.method === 'error') fail(new Error('Codex reported a native agent error. Check its CLI login and configuration.'));
    }, fail, { diagnostics: this.options.diagnostics });
    this.active.add(process);
    void process.closed.then(() => fail(new Error('Codex exited before completing its turn')));
    const request = (method: string, params: unknown, timeout = 30_000): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex timed out during ${method}`)); }, timeout);
      pending.set(id, { resolve, reject, timer }); process.write({ id, method, params });
    });
    const abort = () => { fail(abortError()); process.stop(); };
    turn.signal.addEventListener('abort', abort, { once: true });
    // Attach immediately so setup errors cannot leave an unhandled rejection.
    void result.catch(() => {});
    try {
      await request('initialize', { clientInfo: { name: 'agent-choir', version: '0.1.0' }, capabilities: null });
      process.write({ method: 'initialized', params: {} });
      const authentication = await request('account/read', { refreshToken: false });
      if (authentication.account?.type !== 'chatgpt') {
        throw new Error('Agent Choir requires a ChatGPT subscription login. Run codex login using your ChatGPT account; API and alternate-provider authentication are unsupported.');
      }
      // MCP servers execute outside the file sandbox. Refuse rather than claiming
      // that shell isolation also protects third-party tools. No config is mutated.
      const effective = await request('config/read', { cwd: turn.cwd, includeLayers: false });
      if (!effective.config || typeof effective.config !== 'object') throw new Error('Codex app-server protocol mismatch: effective config missing');
      if (effective.config.model_provider && effective.config.model_provider !== 'openai') {
        throw new Error('Subscription mode requires the native OpenAI model provider. Select it in your Codex configuration before continuing.');
      }
      if (Object.values(effective.config.mcp_servers ?? {}).some((server: any) => server?.enabled !== false)) {
        throw new Error('Agent Choir cannot isolate configured Codex MCP servers. Disable them in native Codex configuration for this project before continuing.');
      }
      if (effective.config.hooks && Object.keys(effective.config.hooks).length) {
        throw new Error('Agent Choir cannot isolate configured Codex hooks. Disable them in native Codex configuration for this project before continuing.');
      }
      let model = turn.model ?? undefined, effort = turn.effort ?? undefined;
      if (turn.model === null || turn.effort === null) {
        const models: import('../types.js').ModelOption[] = [], cursors = new Set<string>();
        let cursor: string | undefined, defaultModel = effective.config.model;
        do {
          const page = await request('model/list', { limit: 100, includeHidden: true, cursor });
          models.push(...parseCodexModels(page.data, true));
          defaultModel ??= page.data.find((item: any) => item.isDefault)?.model;
          cursor = page.nextCursor ?? undefined;
          if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 10)) throw new Error('Invalid Codex model pagination');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        if (turn.model === null) model = defaultModel;
        if (turn.effort === null) {
          const selected = models.find(item => item.id === (model ?? defaultModel));
          const configured = effective.config.model_reasoning_effort;
          effort = typeof configured === 'string' && (!selected || selected.efforts.includes(configured)) ? configured : selected?.defaultEffort;
        }
        if ((turn.model === null && !model) || (turn.effort === null && !effort)) throw new Error('Cannot resolve Codex defaults for this model. Select an explicit model and reasoning effort.');
      }
      const full = turn.writable && turn.permissions?.mode === 'full';
      const roots = [turn.cwd, ...(turn.permissions?.additionalDirectories ?? [])];
      const config = { cwd: turn.cwd, model, approvalPolicy: 'never', sandbox: full ? 'danger-full-access' : turn.writable ? 'workspace-write' : 'read-only',
        config: { features: Object.fromEntries(DISABLED_FEATURES.map(feature => [feature, false])) } };
      const thread = await request(turn.sessionId ? 'thread/resume' : 'thread/start', turn.sessionId ? { ...config, threadId: turn.sessionId } : config);
      threadId = thread.thread?.id;
      if (!threadId) throw new Error('Codex app-server protocol mismatch: thread ID missing');
      emit({ type: 'session', sessionId: threadId });
      if (turn.title) {
        try { await request('thread/name/set', { threadId, name: turn.title }, 5000); }
        catch (error) {
          if (turn.signal.aborted) throw abortError();
          emit({ type: 'activity', text: 'Codex chat title could not be updated. Check native CLI compatibility.' });
        }
      }
      const started = await request('turn/start', {
        threadId, cwd: turn.cwd, model, effort, approvalPolicy: 'never',
        sandboxPolicy: full ? { type: 'dangerFullAccess' } : turn.writable
          ? { type: 'workspaceWrite', writableRoots: roots, networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
          : { type: 'readOnly', networkAccess: false },
        input: [{ type: 'text', text: turn.prompt, text_elements: [] }], outputSchema: REPLY_SCHEMA,
      });
      turnId = started.turn?.id ?? '';
      return await result;
    } finally {
      turn.signal.removeEventListener('abort', abort);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(abortError()); }
      pending.clear(); process.stop(); await process.closed; this.active.delete(process);
    }
  }
  async dispose(): Promise<void> { for (const process of this.active) process.stop(); await Promise.all([...this.active].map(process => process.closed)); }
}
