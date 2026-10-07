import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectController, serveController } from '../src/background.js';
import { createSession } from '../src/engine.js';
import type { UIController, ViewState } from '../src/types.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function setup(instances = false) {
  const directory = await mkdtemp('/tmp/duet-background-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const view: ViewState = { session: createSession({ project: '/tmp/project', scope: 'discuss', brief: 'Brainstorm' }), streams: { claude: '', codex: '' }, busy: { claude: false, codex: false }, recipient: 'both', delivery: 'queued' };
  if (instances) { view.session.agents = [{ id: 'agent-1', provider: 'codex' }]; view.streams = { 'agent-1': '' }; view.busy = { 'agent-1': false }; view.recipient = 'agent-1'; }
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  const controller: UIController = {
    getView: () => structuredClone(view), subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    start: vi.fn(async () => { view.session.status = 'running'; notify(); }),
    pause: vi.fn(async () => { view.session.status = 'paused'; notify(); }),
    send: vi.fn(async (text, to) => { view.session.brief = text; if (to) view.recipient = to; notify(); }),
    collaborate: vi.fn(async text => { view.session.brief = text; view.session.interaction = 'collaborate'; notify(); }),
    setRecipient(to) { view.recipient = to; notify(); }, setDelivery(mode) { view.delivery = mode; notify(); },
    addAgent: vi.fn(async provider => { view.session.agents?.push({ id: 'agent-2', provider }); view.streams['agent-2'] = ''; view.busy['agent-2'] = false; notify(); }),
    setInitialAgent: vi.fn(async provider => { view.session.agents![0]!.provider = provider; notify(); }),
    getModelOptions: vi.fn(async () => ({ models: [{ id: 'model-a', name: 'A', efforts: ['low', 'high'] }] })),
    setModelSettings: vi.fn(async (agent, settings) => { view.session.models = { ...view.session.models, [agent]: settings.model }; view.session.efforts = { ...view.session.efforts, [agent]: settings.effort }; notify(); }),
    resolve: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const server = await serveController(controller, directory, view.session.id);
  cleanups.push(() => server.close());
  return { directory, controller, view, server };
}
describe('background transport', () => {
  it('queries model options and persists per-instance settings through an attached UI', async () => {
    const { directory, controller, view } = await setup(true);
    const client = await connectController(directory, view.session.id);
    cleanups.push(async () => client.disconnect());
    expect((await client.getModelOptions!('agent-1')).models[0].efforts).toEqual(['low', 'high']);
    await client.setModelSettings!('agent-1', { model: 'model-a', effort: 'high' });
    expect(controller.setModelSettings).toHaveBeenCalledWith('agent-1', { model: 'model-a', effort: 'high' });
    expect(client.getView().session).toMatchObject({ models: { 'agent-1': 'model-a' }, efforts: { 'agent-1': 'high' } });
    await expect(client.setModelSettings!('both', { model: null, effort: null })).rejects.toThrow('invalid arguments');
    await expect(client.setModelSettings!('agent-1', { model: '-flag', effort: null })).rejects.toThrow('invalid arguments');
    expect(controller.setModelSettings).toHaveBeenCalledTimes(1);
  });
  it('routes commands and broadcasts view updates to attached peers', async () => {
    const { directory, controller, view } = await setup();
    const client = await connectController(directory, view.session.id);
    const other = await connectController(directory, view.session.id);
    cleanups.push(async () => { client.disconnect(); other.disconnect(); });
    const listener = vi.fn(); other.subscribe(listener);
    await client.start();
    await vi.waitFor(() => expect(other.getView().session.status).toBe('running'));
    await client.send('Use a local database', 'claude', 'immediate');
    expect(controller.send).toHaveBeenCalledWith('Use a local database', 'claude', 'immediate');
    expect(controller.collaborate).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(other.getView().session.brief).toBe('Use a local database'));
    await client.collaborate!('Compare storage designs together');
    expect(controller.collaborate).toHaveBeenCalledWith('Compare storage designs together');
    await vi.waitFor(() => expect(other.getView().session.interaction).toBe('collaborate'));
    expect(listener).toHaveBeenCalled();
    client.setRecipient('codex'); client.setDelivery('immediate');
    await vi.waitFor(() => expect(other.getView().recipient).toBe('codex'));
    await client.resolve('D7', 'Choose SQLite');
    expect(controller.resolve).toHaveBeenCalledWith('D7', 'Choose SQLite');
    await client.pause(); expect(controller.pause).toHaveBeenCalledOnce();
  });
  it('transports provider selection, peer joining and recipient IDs from the current roster', async () => {
    const { directory, controller, view } = await setup(true);
    const client = await connectController(directory, view.session.id);
    cleanups.push(async () => client.disconnect());
    await client.setInitialAgent!('claude');
    expect(controller.setInitialAgent).toHaveBeenCalledWith('claude');
    await client.addAgent!('codex');
    expect(controller.addAgent).toHaveBeenCalledWith('codex');
    await vi.waitFor(() => expect(client.getView().session.agents).toHaveLength(2));
    await client.send('Private instruction', 'agent-2');
    await client.send('Shared instruction', 'both');
    expect(controller.send).toHaveBeenNthCalledWith(1, 'Private instruction', 'agent-2', 'queued');
    expect(controller.send).toHaveBeenNthCalledWith(2, 'Shared instruction', 'both', 'queued');
    await expect(client.send('Wrong instance', 'codex')).rejects.toThrow('invalid arguments');
    client.setRecipient('agent-1');
    await vi.waitFor(() => expect(client.getView().recipient).toBe('agent-1'));
  });
  it('disconnect leaves work running; ordinary close pauses without disposing the worker', async () => {
    const { directory, controller, view } = await setup();
    const client = await connectController(directory, view.session.id);
    await client.start(); client.disconnect();
    expect(controller.pause).not.toHaveBeenCalled(); expect(view.session.status).toBe('running');
    const attached = await connectController(directory, view.session.id);
    await attached.close();
    expect(controller.pause).toHaveBeenCalledOnce(); expect(controller.close).not.toHaveBeenCalled();
    const again = await connectController(directory, view.session.id);
    cleanups.push(async () => again.disconnect());
    expect(again.getView().session.status).toBe('paused');
  });
  it('protects sockets and refuses to overwrite a live worker', async () => {
    const { directory, controller, view } = await setup();
    const [name] = await readdir(join(directory, 'sockets'));
    expect((await stat(join(directory, 'sockets'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, 'sockets', name))).mode & 0o777).toBe(0o600);
    await expect(serveController(controller, directory, view.session.id)).rejects.toThrow('already has');
  });
  it('rejects invalid commands without calling the controller', async () => {
    const { directory, controller, view } = await setup();
    const [name] = await readdir(join(directory, 'sockets'));
    const socket = createConnection(join(directory, 'sockets', name));
    cleanups.push(async () => socket.destroy());
    await new Promise<void>(resolve => socket.once('connect', resolve));
    socket.setEncoding('utf8');
    const response = new Promise<string>(resolve => socket.once('data', data => resolve(String(data))));
    socket.write(JSON.stringify({ id: 1, method: 'send', args: ['hello', 'attacker', 'immediate'] }) + '\n');
    expect(JSON.parse(await response).error).toContain('invalid arguments');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('recovers a stale socket left behind by an exited process', async () => {
    const { directory, controller, view, server } = await setup();
    await server.close();
    const path = join(directory, 'sockets', createHash('sha256').update(view.session.id).digest('hex').slice(0, 24) + '.sock');
    // Rename a bound socket before closing: Node removes the original path, leaving this inode stale.
    const temporary = createServer();
    await new Promise<void>(resolve => temporary.listen(path + '.tmp', resolve));
    const { rename } = await import('node:fs/promises'); await rename(path + '.tmp', path);
    await new Promise<void>(resolve => temporary.close(() => resolve()));
    const recovered = await serveController(controller, directory, view.session.id);
    cleanups.push(() => recovered.close());
    const client = await connectController(directory, view.session.id); cleanups.push(async () => client.disconnect());
    expect(client.getView().session.id).toBe(view.session.id);
  });
});
