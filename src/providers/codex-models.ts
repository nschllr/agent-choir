import type { ModelCatalog, ModelOption } from '../types.js';
import { validEffort, validModel } from '../model-settings.js';
import { JsonProcess, type ProcessOptions } from './process.js';

export function parseCodexModels(data: unknown, includeHidden = false): ModelOption[] {
  if (!Array.isArray(data)) throw new Error('Codex model catalog is missing');
  return data.filter(item => item && (includeHidden || !item.hidden) && validModel(item.model)).map(item => ({
    id: item.model, name: typeof item.displayName === 'string' ? item.displayName : item.model,
    efforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map((entry: any) => entry?.reasoningEffort).filter(validEffort) : [],
    defaultEffort: validEffort(item.defaultReasoningEffort) ? item.defaultReasoningEffort : undefined,
  }));
}

/** Catalog metadata only: no thread, prompt or model turn is created. */
export async function codexModelCatalog(cwd: string, options: ProcessOptions, active: Set<JsonProcess>): Promise<ModelCatalog> {
  let sequence = 0;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const fail = (error: Error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };
  const native = new JsonProcess(options.binary ?? 'codex', [...(options.prefixArgs ?? []), 'app-server', '--listen', 'stdio://'], cwd, message => {
    const request = pending.get(message.id);
    if (!request || message.method) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error('Codex model discovery failed. Check native CLI compatibility.'));
    else request.resolve(message.result);
  }, fail, { diagnostics: options.diagnostics });
  active.add(native);
  void native.closed.then(() => fail(new Error('Codex model discovery exited')));
  const timer = setTimeout(() => { fail(new Error('Codex model discovery timed out')); native.stop(); }, 10_000);
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); native.write({ id, method, params });
  });
  try {
    await request('initialize', { clientInfo: { name: 'agent-duet', version: '0.1.0' }, capabilities: null });
    native.write({ method: 'initialized', params: {} });
    const config = await request('config/read', { cwd, includeLayers: false });
    const models: ModelOption[] = [], cursors = new Set<string>();
    let cursor: string | undefined, defaultModel: string | undefined = config?.config?.model;
    do {
      const page = await request('model/list', { limit: 100, includeHidden: false, cursor });
      models.push(...parseCodexModels(page?.data));
      defaultModel ??= page.data.find((model: any) => model.isDefault)?.model;
      cursor = page.nextCursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || cursors.has(cursor) || cursors.size >= 10)) throw new Error('Invalid Codex model pagination');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return { models: [...new Map(models.map(model => [model.id, model])).values()], defaultModel: validModel(defaultModel) ? defaultModel : undefined };
  } finally {
    clearTimeout(timer); native.stop(); await native.closed; active.delete(native);
  }
}
