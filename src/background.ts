import { createHash } from 'node:crypto';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { agentIds, isProvider } from './agents.js';
import { validModelSettings } from './model-settings.js';
import type { Delivery, Recipient, UIController, ViewState } from './types.js';

const MAX_FRAME = 8 * 1024 * 1024;
const MAX_REQUEST = 100_000;
const deliveries = ['queued', 'immediate'];
type Integrating = UIController & { acceptIntegration?(notes: string): Promise<void> };
function socketPath(stateDir: string, id: string): string {
  const path = join(stateDir, 'sockets', createHash('sha256').update(id).digest('hex').slice(0, 24) + '.sock');
  if (Buffer.byteLength(path) > 100) throw new Error('State directory path is too long for background sockets');
  return path;
}
function write(socket: Socket, value: unknown): void {
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > MAX_FRAME || socket.writableLength > MAX_FRAME) { socket.destroy(new Error('Background transport buffer limit exceeded')); return; }
  if (!socket.destroyed) socket.write(data);
}
function frames(socket: Socket, limit: number, receive: (value: unknown) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    while (true) {
      const end = buffer.indexOf('\n');
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (Buffer.byteLength(line) > limit) { socket.destroy(new Error('Background frame too large')); return; }
      let value: unknown;
      try { value = JSON.parse(line); } catch { socket.destroy(new Error('Invalid background JSON')); return; }
      receive(value);
      if (socket.destroyed) return;
    }
    if (Buffer.byteLength(buffer) > limit) socket.destroy(new Error('Background frame too large'));
  });
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function string(value: unknown, maximum = 40_000): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum; }
async function dispatch(controller: Integrating, method: unknown, args: unknown): Promise<unknown> {
  if (!Array.isArray(args)) throw new Error('Expected command arguments');
  const recipients = [...agentIds(controller.getView().session), 'both'];
  switch (method) {
    case 'getView': if (!args.length) return controller.getView(); break;
    case 'start': if (!args.length) return controller.start(); break;
    case 'pause': case 'close': if (!args.length) return controller.pause(); break;
    case 'send':
      if (args.length >= 1 && args.length <= 3 && string(args[0]) && (args[1] === undefined || recipients.includes(args[1])) && (args[2] === undefined || deliveries.includes(args[2])))
        return controller.send(args[0], args[1] as Recipient | undefined, args[2] as Delivery | undefined);
      break;
    case 'collaborate': if (args.length === 1 && string(args[0]) && controller.collaborate) return controller.collaborate(args[0]); break;
    case 'setRecipient': if (args.length === 1 && recipients.includes(args[0])) return controller.setRecipient(args[0] as Recipient); break;
    case 'addAgent': if (args.length === 1 && isProvider(args[0]) && controller.addAgent) return controller.addAgent(args[0]); break;
    case 'setInitialAgent': if (args.length === 1 && isProvider(args[0]) && controller.setInitialAgent) return controller.setInitialAgent(args[0]); break;
    case 'getModelOptions': if (args.length === 1 && recipients.includes(args[0]) && args[0] !== 'both' && controller.getModelOptions) return controller.getModelOptions(args[0]); break;
    case 'setModelSettings': if (args.length === 2 && recipients.includes(args[0]) && args[0] !== 'both' && validModelSettings(args[1]) && controller.setModelSettings) return controller.setModelSettings(args[0], args[1]); break;
    case 'setDelivery': if (args.length === 1 && deliveries.includes(args[0])) return controller.setDelivery(args[0] as Delivery); break;
    case 'resolve': if (args.length === 2 && string(args[0], 200) && string(args[1])) return controller.resolve(args[0], args[1]); break;
    case 'acceptIntegration': if (args.length === 1 && string(args[0]) && controller.acceptIntegration) return controller.acceptIntegration(args[0]); break;
  }
  throw new Error('Unknown command or invalid arguments');
}
async function isLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Existing background socket did not answer')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(false); else reject(error);
    });
  });
}
/** Starts a private local transport. Disconnected UIs leave controller work running. */
export async function serveController(controller: UIController, stateDir: string, sessionId: string): Promise<{ close(): Promise<void> }> {
  const path = socketPath(stateDir, sessionId), directory = join(stateDir, 'sockets');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid?.()) throw new Error('Socket directory must be owned by the current user');
  await chmod(directory, 0o700);
  try {
    const existing = await lstat(path);
    if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Refusing to replace an unexpected socket path');
    if (await isLive(path)) throw new Error('Session already has a background worker');
    const current = await lstat(path).catch(() => undefined);
    if (current && current.ino !== existing.ino) throw new Error('Background socket changed during recovery');
    if (current) await unlink(path);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const clients = new Set<Socket>();
  const server = createServer(socket => {
    clients.add(socket); socket.on('error', () => {}); socket.once('close', () => clients.delete(socket));
    // Bound in-flight requests; async commands still allow pause during a pending operation.
    let pending = 0;
    frames(socket, MAX_REQUEST, value => {
      if (!object(value) || !Number.isSafeInteger(value.id) || Number(value.id) < 1 || pending >= 32) { socket.destroy(); return; }
      pending++;
      void dispatch(controller, value.method, value.args).then(result => write(socket, { id: value.id, result: result ?? null }), error => write(socket, { id: value.id, error: error instanceof Error ? error.message : String(error) })).finally(() => { pending--; });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
  try { await chmod(path, 0o600); } catch (error) { server.close(); throw error; }
  const unsubscribe = controller.subscribe(() => { for (const socket of clients) write(socket, { event: 'view', view: controller.getView() }); });
  let closed = false;
  return { async close() {
    if (closed) return; closed = true; unsubscribe();
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
/** Attach a cached synchronous UI view to an existing worker. close pauses; disconnect detaches. */
export async function connectController(stateDir: string, sessionId: string): Promise<UIController & { disconnect(): void; acceptIntegration(notes: string): Promise<void> }> {
  const socket = createConnection(socketPath(stateDir, sessionId));
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<() => void>();
  let view: ViewState, sequence = 0, disconnected = false;
  const notify = () => { for (const listener of listeners) listener(); };
  const fail = (error: Error) => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); } pending.clear(); };
  socket.on('error', fail);
  socket.on('close', () => { fail(new Error('Background worker disconnected')); if (view && !disconnected) { view = { ...view, session: { ...view.session, status: 'error', error: 'Background worker disconnected; reconnect to continue.' } }; notify(); } });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  frames(socket, MAX_FRAME, value => {
    if (!object(value)) { socket.destroy(new Error('Invalid background response')); return; }
    if (value.event === 'view' && object(value.view) && object(value.view.session)) { view = value.view as unknown as ViewState; notify(); return; }
    if (typeof value.id !== 'number') return;
    const request = pending.get(value.id); if (!request) return;
    pending.delete(value.id); clearTimeout(request.timer);
    if (typeof value.error === 'string') request.reject(new Error(value.error)); else request.resolve(value.result);
  });
  function request(method: string, args: unknown[] = []): Promise<unknown> {
    if (socket.destroyed) return Promise.reject(new Error('Background connection is closed'));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Background request timed out')); }, 30_000);
      pending.set(id, { resolve, reject, timer }); write(socket, { id, method, args });
    });
  }
  try {
    view = await request('getView') as ViewState;
    if (!object(view) || !object(view.session)) throw new Error('Invalid background view');
  } catch (error) { socket.destroy(); throw error; }
  // Void setters report transport failures through the view, avoiding unhandled rejections.
  const set = (method: string, value: string) => { void request(method, [value]).catch(error => { view = { ...view, session: { ...view.session, error: error.message } }; notify(); }); };
  return {
    getView: () => structuredClone(view),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async start() { await request('start'); }, async pause() { await request('pause'); },
    async send(text, to, delivery) { await request('send', [text, to ?? view.recipient, delivery ?? view.delivery]); },
    async collaborate(text) { await request('collaborate', [text]); },
    setRecipient(to) { set('setRecipient', to); }, setDelivery(mode) { set('setDelivery', mode); },
    async addAgent(provider) { await request('addAgent', [provider]); },
    async setInitialAgent(provider) { await request('setInitialAgent', [provider]); },
    async getModelOptions(agent) { return await request('getModelOptions', [agent]) as import('./types.js').ModelCatalog; },
    async setModelSettings(agent, settings) { await request('setModelSettings', [agent, settings]); },
    async resolve(id, resolution) { await request('resolve', [id, resolution]); },
    async acceptIntegration(notes) { await request('acceptIntegration', [notes]); },
    async close() { try { await request('close'); } finally { disconnected = true; socket.destroy(); } },
    disconnect() { disconnected = true; socket.destroy(); },
  };
}
