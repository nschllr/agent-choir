import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { App } from '../src/ui/App.js';
import { terminalText, tailLines } from '../src/ui/text.js';
import { MouseEvents } from '../src/ui/mouse.js';
import type { UIController, ViewState } from '../src/types.js';

afterEach(cleanup);
// Ink throttles terminal renders; allow a complete frame between key presses.
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

function controllerFixture(solo = false): UIController {
  const listeners = new Set<() => void>();
  let state: ViewState = {
    session: {
      id: 'test-session', createdAt: '', updatedAt: '', project: '/tmp/project', scope: 'discuss', interaction: 'chat',
      brief: 'Explore the design', status: 'running', messages: [
        { id: 'one', at: '', from: 'claude', to: 'both', text: 'Use a local database.' },
        { id: 'two', at: '', from: 'codex', to: 'both', text: 'Let us compare durability.' },
      ], activities: [], decisions: [], completedTasks: {}, finished: {}, providerSessions: {},
      turns: 2, maxTurns: 12, maxMinutes: 20, elapsedMs: 0, demo: true,
    }, streams: { claude: '', codex: '' }, busy: { claude: false, codex: false }, recipient: 'both', delivery: 'queued',
  };
  if (solo) {
    state.session = { ...state.session, agents: [{ id: 'codex', provider: 'codex' }], messages: [], turns: 0, status: 'paused', awaitingInput: true };
    state.recipient = 'codex';
  }
  const update = (change: Partial<ViewState>) => { state = { ...state, ...change }; listeners.forEach(listener => listener()); };
  return {
    getView: () => state,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start: vi.fn(async () => update({ session: { ...state.session, status: 'running' } })),
    pause: vi.fn(async () => update({ session: { ...state.session, status: 'paused' } })),
    send: vi.fn(async () => {}),
    collaborate: vi.fn(async () => update({ session: { ...state.session, interaction: 'collaborate', status: 'running' } })),
    resolve: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    addAgent: vi.fn(async provider => {
      const agents = state.session.agents ?? [];
      const id = agents.some(agent => agent.id === provider) ? `${provider}-2` : provider;
      update({ session: { ...state.session, agents: [...agents, { id, provider }] } });
    }),
    setInitialAgent: vi.fn(async provider => update({ session: { ...state.session, agents: [{ id: provider, provider }] }, recipient: provider })),
    getModelOptions: vi.fn(async () => ({ defaultModel: 'model-a', models: [{ id: 'model-a', name: 'Model A', efforts: ['low', 'high'] }, { id: 'model-b', name: 'Model B', efforts: ['medium'] }] })),
    setModelSettings: vi.fn(async (agent, settings) => update({ session: { ...state.session, models: { ...state.session.models, [agent]: settings.model }, efforts: { ...state.session.efforts, [agent]: settings.effort } } })),
    setLimits: vi.fn(async limits => update({ session: { ...state.session, ...limits } })),
    setPermissions: vi.fn(async settings => update({ session: { ...state.session, permissions: settings, scope: settings.mode === 'read-only' ? 'discuss' : 'build', status: 'paused' } })),
    setRecipient: vi.fn(to => update({ recipient: to })),
    setDelivery: vi.fn(delivery => update({ delivery })),
  };
}

describe('terminal text handling', () => {
  it('strips ANSI styling, hyperlinks, terminal commands, and C1 controls', () => {
    expect(terminalText('\x1b[31mRed\x1b[0m\n\x1b]8;;https://evil.example\x07link\x1b]8;;\x1b\\\x00\x85')).toBe('Red\nlink');
    expect(terminalText('safe\x1b]52;c;clipboard-payload')).toBe('safe');
  });
  it('bounds output and supports history offset', () => {
    expect(tailLines('first\nsecond\nthird\nfourth', 20, 2)).toBe('third\nfourth');
    expect(tailLines('first\nsecond\nthird\nfourth', 20, 2, 1)).toBe('second\nthird');
  });
});

describe('terminal collaboration workspace', () => {
  it('animates work below the active peer transcript while preserving input and a frozen copy view', async () => {
    const controller = controllerFixture();
    controller.getView().busy.codex = true;
    controller.getView().session.activities = [{ id: 'tool', at: '', agent: 'codex', kind: 'tool', text: 'Checking project files' }];
    const screen = render(<App controller={controller}/>); await settle();
    Object.defineProperty(screen.stdout, 'columns', { value: 120 });
    Object.defineProperty(screen.stdout, 'rows', { value: 38 });
    screen.stdout.emit('resize'); await settle();
    const first = screen.lastFrame()!;
    expect(first.match(/Working…/g)).toHaveLength(1);
    expect(first.indexOf('Working…')).toBeGreaterThan(first.indexOf('Let us compare durability.'));
    expect(first).toContain('Checking project files');
    expect(first).toMatch(/Working… · \d+s/);
    const spinner = (frame: string) => frame.match(/(\S) Working…/)?.[1];
    await vi.waitFor(() => expect(spinner(screen.lastFrame()!)).not.toBe(spinner(first)), { interval: 30 });
    screen.stdin.write('Draft survives animation'); await settle();
    expect(screen.lastFrame()).toContain('Draft survives animation');
    screen.stdin.write('\x19'); await settle();
    const copy = screen.lastFrame();
    expect(copy).toContain('COPY MODE');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(screen.lastFrame()).toBe(copy);
    screen.stdin.write('\x1b'); await settle();
    expect(screen.lastFrame()).toContain('Working…');
    expect(screen.lastFrame()).toContain('Draft survives animation');
    controller.getView().busy.codex = false;
    controller.setRecipient('codex'); await settle();
    expect(screen.lastFrame()).not.toContain('Working…');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('keeps a working indicator visible in compact stacked panes', async () => {
    const controller = controllerFixture();
    controller.getView().busy = { codex: true, claude: true };
    const screen = render(<App controller={controller}/>); await settle();
    Object.defineProperty(screen.stdout, 'columns', { value: 60 });
    Object.defineProperty(screen.stdout, 'rows', { value: 24 });
    screen.stdout.emit('resize'); await settle();
    expect(screen.lastFrame()!.match(/Working…/g)).toHaveLength(2);
    expect(screen.lastFrame()).toContain('direct chat');
  });
  it('shows and edits limits without sending commands to agents, and displays usage since the last message', async () => {
    const controller = controllerFixture();
    controller.getView().session.allowanceStart = { turns: 1, elapsedMs: 0 };
    const screen = render(<App controller={controller}/>); await settle();
    expect(screen.lastFrame()).toContain('turns 1/12');
    const command = async (text: string) => { screen.stdin.write(text); await settle(); screen.stdin.write('\r'); await settle(); };
    await command('/limits'); expect(screen.lastFrame()).toContain('12 turns, 20 active minutes');
    await command('/limits turns 50'); expect(controller.setLimits).toHaveBeenLastCalledWith({ maxTurns: 50, maxMinutes: 20 });
    expect(screen.lastFrame()).toContain('turns 1/50');
    await command('/limits minutes 2.5'); expect(controller.setLimits).toHaveBeenLastCalledWith({ maxTurns: 50, maxMinutes: 2.5 });
    await command('/limits turns 0'); expect(screen.lastFrame()).toContain('positive whole number');
    expect(controller.setLimits).toHaveBeenCalledTimes(2);
    expect(controller.send).not.toHaveBeenCalled(); expect(controller.collaborate).not.toHaveBeenCalled();
  });
  it('changes session permissions through the picker without sending or losing a draft', async () => {
    const controller = controllerFixture(true), mouse = new MouseEvents();
    controller.getView().session.demo = false;
    const screen = render(<App controller={controller} mouse={mouse}/>); await settle();
    screen.stdin.write('Preserve draft'); await settle();
    screen.stdin.write('\x0c'); await settle();
    expect(screen.lastFrame()).toContain('Session permissions');
    mouse.emit('mouse', { action: 'click', x: 10, y: 5 });
    screen.stdin.write('\x1b[B'); await settle();
    screen.stdin.write('a'); await settle(); screen.stdin.write('../shared'); await settle(); screen.stdin.write('\r'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.setPermissions).toHaveBeenCalledWith({ mode: 'project', additionalDirectories: ['../shared'] });
    expect(screen.lastFrame()).toContain('Preserve draft');
    expect(screen.lastFrame()).toContain('project edits');
    expect(controller.send).not.toHaveBeenCalled(); expect(controller.setRecipient).not.toHaveBeenCalled();
    screen.stdin.write('\x15'); await settle(); screen.stdin.write('/permissions full'); await settle(); screen.stdin.write('\r'); await settle();
    expect(controller.setPermissions).toHaveBeenLastCalledWith({ mode: 'full', additionalDirectories: ['../shared'] });
    expect(screen.lastFrame()).toContain('full access');
    screen.stdin.write('\x0c'); await settle(); screen.stdin.write('\x1b[B'); await settle(); screen.stdin.write('\x1b'); await settle();
    expect(controller.setPermissions).toHaveBeenCalledTimes(2);
  });
  it('shows the saved session error without requiring tool activity to be enabled', async () => {
    const controller = controllerFixture();
    controller.getView().session.status = 'error';
    controller.getView().session.error = 'Claude could not refresh its subscription login. Retry in a minute.';
    const screen = render(<App controller={controller}/>); await settle();
    expect(screen.lastFrame()).toContain('Error: Claude could not refresh its subscription login. Retry in a minute.');
    expect(screen.lastFrame()).toContain('direct chat');
  });
  it('selects a model and supported effort for the focused peer without sending or losing a draft', async () => {
    const controller = controllerFixture();
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('Draft remains'); await settle(); screen.stdin.write('\x12'); await settle();
    expect(screen.lastFrame()).toContain('Model & reasoning · Claude');
    await vi.waitFor(() => expect(screen.lastFrame()).toContain('Model A (model-a)'));
    screen.stdin.write('\x1b[B'); await settle();
    screen.stdin.write('\x1b[C'); await settle(); screen.stdin.write('\x1b[C'); await settle();
    expect(screen.lastFrame()).toContain('Reasoning effort: high');
    screen.stdin.write('\r'); await settle();
    expect(controller.setModelSettings).toHaveBeenCalledWith('claude', { model: 'model-a', effort: 'high' });
    expect(screen.lastFrame()).toContain('Draft remains');
    expect(controller.send).not.toHaveBeenCalled(); expect(controller.setRecipient).not.toHaveBeenCalled();
    screen.stdin.write('\x06'); await settle(); screen.stdin.write('\x12'); await settle();
    expect(screen.lastFrame()).toContain('Model & reasoning · Codex');
    screen.stdin.write('\x1b[B'); await settle(); screen.stdin.write('\x1b[B'); await settle();
    screen.stdin.write('\x1b[C'); await settle();
    expect(screen.lastFrame()).toContain('Reasoning effort: medium');
    screen.stdin.write('\x1b'); await settle();
    expect(controller.setModelSettings).toHaveBeenCalledTimes(1);
    expect(screen.lastFrame()).toContain('Draft remains');
  });
  it('supports custom model IDs and explicit reset through commands', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('\x12'); await settle(); screen.stdin.write('\x1b[A'); await settle();
    screen.stdin.write('\r'); await settle(); screen.stdin.write('custom-codex'); await settle();
    screen.stdin.write('\r'); await settle(); screen.stdin.write('\x1b[C'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.setModelSettings).toHaveBeenLastCalledWith('codex', { model: 'custom-codex', effort: 'none' });
    screen.stdin.write('/effort high'); await settle(); screen.stdin.write('\r'); await settle();
    expect(controller.setModelSettings).toHaveBeenLastCalledWith('codex', { model: 'custom-codex', effort: 'high' });
    screen.stdin.write('/model default'); await settle(); screen.stdin.write('\r'); await settle();
    expect(controller.setModelSettings).toHaveBeenLastCalledWith('codex', { model: null, effort: null });
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('freezes a single-pane copy view, disables mouse tracking, and preserves drafts and routing', async () => {
    const controller = controllerFixture(), mouse = new MouseEvents(), tracking = vi.fn();
    mouse.on('tracking', tracking);
    controller.getView().session.messages = [
      { id: 'old', from: 'claude', to: 'claude', at: '', text: 'Select and copy this message.' },
      { id: 'code', from: 'claude', to: 'claude', at: '', text: '```js\n' + Array.from({ length: 8 }, (_, i) => `line_${i}`).join('\n') + '\n```' },
      { id: 'private', from: 'codex', to: 'codex', at: '', text: 'Other pane private message' },
    ];
    const screen = render(<App controller={controller} mouse={mouse}/>); await settle();
    screen.stdin.write('Draft stays'); await settle(); screen.stdin.write('\x19'); await settle();
    expect(screen.lastFrame()).toContain('COPY MODE · Claude');
    expect(screen.lastFrame()).toContain('line_7'); // Copy view includes full code, without fold controls.
    expect(screen.lastFrame()).not.toContain('Ctrl+X expand');
    expect(screen.lastFrame()).not.toContain('Other pane private message');
    expect(tracking).toHaveBeenLastCalledWith(false);
    controller.getView().streams.claude = 'New reply arriving'; controller.setDelivery('queued'); await settle();
    expect(screen.lastFrame()).not.toContain('New reply arriving');
    mouse.emit('mouse', { action: 'click', x: 75, y: 5 });
    screen.stdin.write('\x03'); await settle(); // Copy shortcut cannot accidentally exit the app.
    expect(controller.close).not.toHaveBeenCalled(); expect(controller.setRecipient).not.toHaveBeenCalled();
    screen.stdin.write('\x1b'); await settle();
    expect(tracking).toHaveBeenLastCalledWith(true);
    expect(screen.lastFrame()).toContain('Draft stays'); expect(screen.lastFrame()).toContain('New reply arriving');
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Draft stays', 'both', 'queued');
  });
  it('scrolls the copy snapshot without changing the pane history behind it', async () => {
    const controller = controllerFixture(true), mouse = new MouseEvents();
    controller.getView().session.messages = Array.from({ length: 35 }, (_, i) => ({ id: `m${i}`, from: 'codex', to: 'codex', at: '', text: `Copy history ${i}` }));
    const screen = render(<App controller={controller} mouse={mouse}/>); await settle();
    screen.stdin.write('\x1b[H'); await settle();
    screen.stdin.write('\x19'); await settle();
    expect(screen.lastFrame()).toContain('Copy history 0');
    screen.stdin.write('\x1b[F'); await settle();
    expect(screen.lastFrame()).toContain('Copy history 34');
    screen.stdin.write('\x19'); await settle();
    expect(screen.lastFrame()).toContain('Copy history 0');
    expect(screen.lastFrame()).not.toContain('Copy history 34');
  });
  it('scrolls the hovered pane with the wheel and clicks to select a direct recipient', async () => {
    const controller = controllerFixture(), mouse = new MouseEvents();
    controller.getView().session.messages = ['claude', 'codex'].flatMap(agent => Array.from({ length: 40 }, (_, i) => ({ id: `${agent}-${i}`, at: '', from: agent, to: agent, text: `${agent} message ${String(i).padStart(2, '0')}` })));
    const screen = render(<App controller={controller} mouse={mouse}/>); await settle();
    screen.stdin.write('Draft stays here'); await settle();
    mouse.emit('mouse', { action: 'up', x: 75, y: 6 });
    mouse.emit('mouse', { action: 'up', x: 75, y: 6 }); await settle();
    expect(screen.lastFrame()).toContain('claude message 39');
    expect(screen.lastFrame()).not.toContain('codex message 39');
    expect(screen.lastFrame()).toContain('codex message 36');
    expect(controller.setRecipient).not.toHaveBeenCalled();
    mouse.emit('mouse', { action: 'click', x: 75, y: 6 }); await settle();
    expect(screen.lastFrame()).toContain('▸ Codex');
    expect(controller.setRecipient).toHaveBeenLastCalledWith('codex');
    mouse.emit('mouse', { action: 'click', x: 2, y: 0 }); await settle(); // Header is not a pane.
    expect(controller.setRecipient).toHaveBeenCalledTimes(1);
    expect(screen.lastFrame()).toContain('Draft stays here');
    screen.stdin.write('\x1b[F'); await settle();
    expect(screen.lastFrame()).toContain('codex message 39');
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Draft stays here', 'codex', 'queued');
  });
  it('hit-tests stacked panes after resize and keeps collaboration routing when clicking', async () => {
    const controller = controllerFixture(), mouse = new MouseEvents();
    const screen = render(<App controller={controller} mouse={mouse}/>); await settle();
    Object.defineProperty(screen.stdout, 'columns', { value: 60 });
    Object.defineProperty(screen.stdout, 'rows', { value: 40 });
    screen.stdout.emit('resize'); await settle();
    mouse.emit('mouse', { action: 'click', x: 10, y: 20 }); await settle();
    expect(screen.lastFrame()).toContain('▸ Codex');
    expect(controller.setRecipient).toHaveBeenLastCalledWith('codex');
    screen.stdin.write('\x02'); await settle();
    mouse.emit('mouse', { action: 'click', x: 10, y: 5 }); await settle();
    expect(screen.lastFrame()).toContain('▸ Claude');
    expect(screen.lastFrame()).toContain('collaboration ON');
    expect(controller.setRecipient).toHaveBeenCalledTimes(1);
    screen.stdin.write('Shared task'); await settle(); screen.stdin.write('\r'); await settle();
    expect(controller.collaborate).toHaveBeenCalledWith('Shared task');
  });
  it('wraps long drafts, follows the cursor, and sends the original text after editing', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>); await settle();
    const draft = 'BEGIN ' + 'words '.repeat(25) + 'END';
    screen.stdin.write(draft); await settle();
    expect(screen.lastFrame()).toContain('› BEGIN'); expect(screen.lastFrame()).toContain('END');
    screen.stdin.write(' more'.repeat(100)); await settle();
    expect(screen.lastFrame()).not.toContain('› BEGIN');
    screen.stdin.write('\x01'); await settle();
    expect(screen.lastFrame()).toContain('› BEGIN');
    screen.stdin.write('Edited '); await settle();
    screen.stdin.write('\x05'); await settle();
    expect(screen.lastFrame()).toContain('more');
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Edited ' + draft + ' more'.repeat(100), 'codex', 'queued');
  });
  it('preserves rapid input order and submits all characters before the next render', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>); await settle();
    for (const character of 'to type quickly') screen.stdin.write(character);
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('to type quickly', 'codex', 'queued');
    expect(screen.lastFrame()).not.toContain('to type quickly');
  });
  it('applies rapid cursor moves, Unicode deletion, insertion and clear to the latest draft', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>); await settle();
    for (const input of ['ab👩‍💻cd', '\x1b[D', '\x1b[D', '\x7f', 'X', 'Y', '\x1b[C', 'Z', '\x01', '>', '\x05', '!', '\r']) screen.stdin.write(input);
    await settle();
    expect(controller.send).toHaveBeenCalledWith('>abXYcZd!', 'codex', 'queued');
    for (const input of ['discard', '\x15', 'n', 'e', 'w', '\r']) screen.stdin.write(input);
    await settle();
    expect(controller.send).toHaveBeenLastCalledWith('new', 'codex', 'queued');
  });
  it('previews five code lines and expands independently in the focused pane without changing the draft or recipient', async () => {
    const controller = controllerFixture();
    controller.getView().session.messages = ['claude', 'codex'].map(agent => ({ id: `code-${agent}`, from: agent, to: agent, at: '',
      text: '```js\n' + Array.from({ length: 7 }, (_, i) => `${agent}_LINE_${i + 1}`).join('\n') + '\n```' }));
    const screen = render(<App controller={controller}/>); await settle();
    expect(screen.lastFrame()).toContain('claude_LINE_5'); expect(screen.lastFrame()).toContain('+2 lines');
    expect(screen.lastFrame()).not.toContain('claude_LINE_6'); expect(screen.lastFrame()).not.toContain('codex_LINE_6');
    screen.stdin.write('Draft preserved'); await settle();
    screen.stdin.write('\x18'); await settle(); // Ctrl+X expands code in the focused first pane.
    expect(screen.lastFrame()).toContain('claude_LINE_7'); expect(screen.lastFrame()).not.toContain('codex_LINE_6');
    screen.stdin.write('\x06'); await settle(); // Ctrl+F changes pane focus only.
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).toContain('codex_LINE_7'); expect(screen.lastFrame()).toContain('claude_LINE_7');
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).not.toContain('codex_LINE_6'); expect(screen.lastFrame()).toContain('claude_LINE_7');
    expect(screen.lastFrame()).toContain('Draft preserved');
    expect(controller.setRecipient).not.toHaveBeenCalled(); expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Draft preserved', 'both', 'queued');
  });
  it('cycles among visible code blocks and expands the selected block', async () => {
    const controller = controllerFixture(true);
    const block = (label: string) => '```text\n' + Array.from({ length: 6 }, (_, i) => `${label}_${i + 1}`).join('\n') + '\n```';
    controller.getView().session.messages = [{ id: 'codes', from: 'codex', to: 'codex', at: '', text: block('FIRST') + '\nBetween\n' + block('SECOND') }];
    const screen = render(<App controller={controller}/>); await settle();
    expect(screen.lastFrame()).toContain('Code 1/2');
    screen.stdin.write('\x0b'); await settle(); // Ctrl+K selects the next visible block.
    expect(screen.lastFrame()).toContain('Code 2/2');
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).toContain('SECOND_6'); expect(screen.lastFrame()).not.toContain('FIRST_6');
    screen.stdin.write('\x0b'); await settle();
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).toContain('FIRST_6'); expect(screen.lastFrame()).toContain('SECOND_6');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('keeps streamed code expanded when it grows and becomes a saved reply without its commentary prefix', async () => {
    const controller = controllerFixture(true);
    const partial = '```ts\nconst a = 1;\nsecond\nthird\nfourth\nfifth\nSTREAM_SIXTH';
    controller.getView().streams.codex = 'Investigating first.\n' + partial;
    const screen = render(<App controller={controller}/>); await settle();
    expect(screen.lastFrame()).not.toContain('STREAM_SIXTH');
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).toContain('STREAM_SIXTH');
    const complete = partial + '\nSTREAM_SEVENTH\n```';
    controller.getView().streams.codex = 'Investigating first.\n' + complete;
    controller.setDelivery('immediate'); await settle();
    expect(screen.lastFrame()).toContain('STREAM_SEVENTH');
    controller.getView().streams.codex = '';
    controller.getView().session.messages.push({ id: 'accepted', from: 'codex', to: 'codex', at: '', text: complete });
    controller.setDelivery('queued'); await settle();
    expect(screen.lastFrame()).toContain('STREAM_SEVENTH');
    screen.stdin.write('\x18'); await settle();
    expect(screen.lastFrame()).not.toContain('STREAM_SIXTH');
  });
  it('keeps a scrolled prose row when commentary is removed from the accepted reply', async () => {
    const controller = controllerFixture(true);
    const complete = Array.from({ length: 80 }, (_, i) => `Retained intro ${i}`).join('\n') + '\n```ts\nconst value = 1;\n```';
    controller.getView().streams.codex = 'Temporary commentary.\n' + complete;
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('\x1b[5~'); await settle();
    const visible = screen.lastFrame()!.match(/Retained intro \d+/g);
    expect(visible?.length).toBeGreaterThan(0);
    controller.getView().streams.codex = '';
    controller.getView().session.messages.push({ id: 'accepted', from: 'codex', to: 'codex', at: '', text: complete });
    controller.setDelivery('queued'); await settle();
    expect(screen.lastFrame()!.match(/Retained intro \d+/g)).toEqual(visible);
    expect(screen.lastFrame()).toContain('history · End latest');
  });
  it('scrolls each pane independently, clamps at the oldest message, and preserves input and routing', async () => {
    const controller = controllerFixture();
    controller.getView().session.messages = ['claude', 'codex'].flatMap(agent => Array.from({ length: 30 }, (_, i) => ({ id: `${agent}-${i}`, at: '', from: agent, to: agent, text: `${agent} message ${String(i).padStart(2, '0')}` })));
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('Draft stays here'); await settle();
    expect(screen.lastFrame()).toContain('claude message 29');
    expect(screen.lastFrame()).toContain('codex message 29');
    screen.stdin.write('\x1b[H'); await settle(); // Home: oldest in the focused first pane.
    expect(screen.lastFrame()).toContain('claude message 00');
    expect(screen.lastFrame()).not.toContain('claude message 29');
    expect(screen.lastFrame()).toContain('codex message 29');
    screen.stdin.write('\x1b[5~'); await settle();
    expect(screen.lastFrame()).toContain('claude message 00');
    expect(screen.lastFrame()).toContain('Draft stays here');
    screen.stdin.write('\x06'); await settle(); // Ctrl+F moves scroll focus, not the recipient.
    screen.stdin.write('\x1b[H'); await settle();
    expect(screen.lastFrame()).toContain('codex message 00');
    expect(screen.lastFrame()).toContain('claude message 00');
    screen.stdin.write('\x1b[6~'); await settle();
    expect(screen.lastFrame()).not.toContain('codex message 00');
    screen.stdin.write('\x1b[F'); await settle();
    expect(screen.lastFrame()).toContain('codex message 29');
    expect(screen.lastFrame()).toContain('claude message 00');
    expect(controller.setRecipient).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Draft stays here', 'both', 'queued');
  });
  it('keeps history stationary during new output and follows again after End', async () => {
    const controller = controllerFixture();
    controller.getView().session.messages = Array.from({ length: 35 }, (_, i) => ({ id: `m-${i}`, at: '', from: 'claude', to: 'claude', text: `History entry ${String(i).padStart(2, '0')}` }));
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('\x1b[5~'); await settle();
    const visible = screen.lastFrame()!.match(/History entry \d+/g);
    expect(visible?.length).toBeGreaterThan(0);
    controller.getView().streams.claude = 'New streamed output\n'.repeat(20);
    controller.setDelivery('immediate'); await settle(); // Publish the updated view.
    expect(screen.lastFrame()!.match(/History entry \d+/g)).toEqual(visible);
    expect(screen.lastFrame()).not.toContain('New streamed output');
    screen.stdin.write('\x1b[F'); await settle();
    expect(screen.lastFrame()).toContain('New streamed output');
    expect(screen.lastFrame()).toContain('live · PgUp history');
  });
  it('shows two peer panes, read-only permissions, and streaming output', async () => {
    const controller = controllerFixture();
    controller.getView().streams.codex = 'Investigating persistence';
    const screen = render(<App controller={controller}/>);
    await settle();
    expect(screen.lastFrame()).toContain('Claude');
    expect(screen.lastFrame()).toContain('Codex');
    expect(screen.lastFrame()).toContain('read-only');
    expect(screen.lastFrame()).toContain('Investigating persistence');
    expect(screen.lastFrame()).toContain('To both');
  });
  it('routes multiline input to the selected recipient and steering mode', async () => {
    const controller = controllerFixture();
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('\t'); await settle();
    screen.stdin.write('\x13'); await settle(); // Ctrl+S
    screen.stdin.write('First line'); await settle();
    screen.stdin.write('\n'); await settle(); // Ctrl+J / newline
    screen.stdin.write('Second line'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('First line\nSecond line', 'claude', 'immediate');
    expect(controller.collaborate).not.toHaveBeenCalled();
  });
  it('shows unresolved decisions and routes a resolution command', async () => {
    const controller = controllerFixture();
    controller.getView().session.decisions.push({
      id: 'storage', kind: 'decision', title: 'Persistence', proposal: 'Use SQLite', version: 2,
      tasks: [], positions: { claude: { position: 'accept', reason: 'Local scope', version: 2 }, codex: { position: 'accept', reason: 'Old proposal', version: 1 } },
      rounds: 2, status: 'waiting_user',
    });
    const screen = render(<App controller={controller}/>);
    await settle();
    expect(screen.lastFrame()).toContain('storage');
    expect(screen.lastFrame()).toContain('Claude: accept');
    expect(screen.lastFrame()).toContain('Codex: pending');
    expect(screen.lastFrame()).toContain('/resolve storage');
    screen.stdin.write('/resolve storage SQLite for local scope'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.resolve).toHaveBeenCalledWith('storage', 'SQLite for local scope');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('pauses and resumes with keyboard controls, closes through the controller', async () => {
    const controller = controllerFixture();
    const onExit = vi.fn();
    const screen = render(<App controller={controller} onExit={onExit}/>);
    await settle();
    screen.stdin.write('\x10'); await settle();
    expect(controller.pause).toHaveBeenCalledOnce();
    screen.stdin.write('\x10'); await settle();
    expect(controller.start).toHaveBeenCalledOnce();
    screen.stdin.write('\x03'); await settle();
    expect(controller.close).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
  });
  it('keeps completed conversations open and starts a follow-up after sending it', async () => {
    const controller = controllerFixture();
    controller.getView().session.status = 'complete';
    const onExit = vi.fn();
    const order: string[] = [];
    controller.send = vi.fn(async () => { order.push('send'); });
    controller.start = vi.fn(async () => { order.push('start'); });
    const screen = render(<App controller={controller} onExit={onExit}/>);
    await settle();
    expect(screen.lastFrame()).toContain('send a follow-up to continue');
    expect(onExit).not.toHaveBeenCalled();
    expect(controller.close).not.toHaveBeenCalled();
    screen.stdin.write('Consider another approach'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Consider another approach', 'both', 'queued');
    expect(order).toEqual(['send', 'start']);
    expect(onExit).not.toHaveBeenCalled();
  });
  it('keeps messages queued when the session was deliberately paused', async () => {
    const controller = controllerFixture();
    controller.getView().session.status = 'paused';
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('Wait for my next instruction'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Wait for my next instruction', 'both', 'queued');
    expect(controller.start).not.toHaveBeenCalled();
  });
  it('shows the combined candidate and accepts explicit validation evidence', async () => {
    const controller = controllerFixture();
    controller.getView().session.integration = { status: 'review', path: '/tmp/combined-candidate' };
    controller.acceptIntegration = vi.fn(async () => {});
    const screen = render(<App controller={controller}/>);
    await settle();
    expect(screen.lastFrame()).toContain('Integration · review');
    expect(screen.lastFrame()).toContain('/tmp/combined-candidate');
    expect(screen.lastFrame()).toContain('/accept');
    screen.stdin.write('/accept npm test passed on combined candidate'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.acceptIntegration).toHaveBeenCalledWith('npm test passed on combined candidate');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('detaches through the controller without closing or pausing the session', async () => {
    const controller = controllerFixture();
    controller.detach = vi.fn(async () => {});
    const onExit = vi.fn();
    const screen = render(<App controller={controller} onExit={onExit}/>);
    await settle();
    screen.stdin.write('/detach'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.detach).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(controller.close).not.toHaveBeenCalled();
    expect(controller.pause).not.toHaveBeenCalled();
  });
  it('explains the background startup command when detach is unavailable', async () => {
    const controller = controllerFixture();
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('/detach'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(screen.lastFrame()).toContain('Start using --detach');
    expect(controller.close).not.toHaveBeenCalled();
  });
  it('keeps a directed chat reply in the addressed agent pane', async () => {
    const controller = controllerFixture();
    controller.getView().session.interaction = 'chat';
    controller.getView().session.messages = [
      { id: 'hi', at: '', from: 'user', to: 'codex', text: 'hi' },
      { id: 'reply', at: '', from: 'codex', to: 'codex', text: 'Hello from the selected agent.' },
    ];
    const screen = render(<App controller={controller}/>);
    await settle();
    const frame = screen.lastFrame()!;
    expect(frame).toContain('· chat · read-only');
    expect(frame.match(/Hello from the selected agent\./g)).toHaveLength(1);
    expect(frame.match(/You › hi/g)).toHaveLength(1);
    expect(frame).toContain('Start a conversation with Claude.');
  });
  it('starts collaboration only through an explicit task command', async () => {
    const controller = controllerFixture();
    controller.getView().session.interaction = 'chat';
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('/collaborate Compare the storage options'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.collaborate).toHaveBeenCalledWith('Compare the storage options');
    expect(controller.send).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    expect(screen.lastFrame()).toContain('· collaborating · read-only');
  });
  it('enables collaboration before typing without submitting and keeps it enabled for follow-ups', async () => {
    const controller = controllerFixture();
    controller.getView().session.interaction = 'chat';
    controller.getView().session.brief = 'hi';
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('\x02'); await settle();
    expect(screen.lastFrame()).toContain('collaboration ON');
    expect(controller.collaborate).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await settle();
    expect(controller.collaborate).not.toHaveBeenCalled();
    screen.stdin.write('Brainstorm interface options'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.collaborate).toHaveBeenCalledOnce();
    expect(controller.collaborate).toHaveBeenCalledWith('Brainstorm interface options');
    expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('Consider simpler options'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.collaborate).toHaveBeenCalledTimes(2);
    expect(controller.collaborate).toHaveBeenLastCalledWith('Consider simpler options');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('preserves a typed draft through mode toggles and keeps both as independent chat recipients', async () => {
    const controller = controllerFixture();
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('Draft to both'); await settle();
    screen.stdin.write('\x02'); await settle();
    expect(screen.lastFrame()).toContain('Draft to both');
    expect(screen.lastFrame()).toContain('With Claude + Codex');
    expect(controller.collaborate).not.toHaveBeenCalled();
    screen.stdin.write('\t'); await settle();
    expect(controller.setRecipient).not.toHaveBeenCalled();
    screen.stdin.write('\x02'); await settle();
    expect(screen.lastFrame()).toContain('direct chat');
    expect(screen.lastFrame()).toContain('Draft to both');
    expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Draft to both', 'both', 'queued');
    expect(controller.collaborate).not.toHaveBeenCalled();
  });
  it('supports enabling collaboration with a command and disabling it with /chat', async () => {
    const controller = controllerFixture();
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('/collaborate'); await settle(); screen.stdin.write('\r'); await settle();
    expect(screen.lastFrame()).toContain('collaboration ON');
    expect(controller.collaborate).not.toHaveBeenCalled();
    screen.stdin.write('/chat'); await settle(); screen.stdin.write('\r'); await settle();
    expect(screen.lastFrame()).toContain('direct chat');
    expect(controller.send).not.toHaveBeenCalled();
  });
  it('waits for active collaboration to pause before sending a direct message after toggling off', async () => {
    const controller = controllerFixture();
    controller.getView().session.interaction = 'collaborate';
    let finishPause!: () => void;
    controller.pause = vi.fn(() => new Promise<void>(resolve => { finishPause = resolve; }));
    const screen = render(<App controller={controller}/>); await settle();
    screen.stdin.write('Direct follow-up'); await settle(); screen.stdin.write('\x02'); await settle();
    expect(controller.pause).toHaveBeenCalledOnce();
    expect(screen.lastFrame()).toContain('Direct follow-up');
    screen.stdin.write('\r'); await settle();
    expect(controller.send).not.toHaveBeenCalled();
    finishPause(); await settle();
    expect(controller.send).toHaveBeenCalledWith('Direct follow-up', 'both', 'queued');
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.collaborate).not.toHaveBeenCalled();
  });
  it('requires a second agent before explicitly starting collaboration', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('Compare options'); await settle();
    screen.stdin.write('\x02'); await settle();
    expect(screen.lastFrame()).toContain('Add a second agent');
    expect(screen.lastFrame()).toContain('Compare options');
    expect(controller.collaborate).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });
});


describe('single-first agent workspace', () => {
  it('opens one blank agent without starting a model or asking an opening question', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>);
    await settle();
    expect(screen.lastFrame()).toContain('Start a conversation with Codex.');
    expect(screen.lastFrame()).toContain('To Codex');
    expect(screen.lastFrame()).not.toContain('Claude');
    expect(screen.lastFrame()).not.toContain('Choose agent');
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.collaborate).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    screen.stdin.write('Explore this repository'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Explore this repository', 'codex', 'queued');
    expect(controller.start).toHaveBeenCalledOnce();
  });
  it('opens an inert second-pane picker and cancels without spawning an agent', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('\x0e'); await settle(); // Ctrl+N
    expect(screen.lastFrame()).toContain('Choose agent');
    expect(screen.lastFrame()).toContain('Claude');
    expect(controller.addAgent).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
    screen.stdin.write('\x1b'); await settle();
    expect(screen.lastFrame()).not.toContain('Choose agent');
    expect(screen.lastFrame()).not.toContain('Claude');
    expect(controller.addAgent).not.toHaveBeenCalled();
  });
  it('adds another Codex instance and routes messages by distinct names and shortcuts', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('\x0e'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.addAgent).toHaveBeenCalledWith('codex');
    expect(screen.lastFrame()).toContain('Codex 1');
    expect(screen.lastFrame()).toContain('Codex 2');
    expect(screen.lastFrame()).not.toContain('Choose agent');
    expect(controller.start).not.toHaveBeenCalled();
    screen.stdin.write('\t'); await settle();
    expect(screen.lastFrame()).toContain('To Codex 2');
    screen.stdin.write('Review the approach'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Review the approach', 'codex-2', 'queued');
    screen.stdin.write('\t'); await settle();
    expect(screen.lastFrame()).toContain('To both');
    screen.stdin.write('Discuss alternatives'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.send).toHaveBeenCalledWith('Discuss alternatives', 'both', 'queued');
    screen.stdin.write('/to Codex 1'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.setRecipient).toHaveBeenLastCalledWith('codex');
    screen.stdin.write('\x1b[Z'); await settle(); // Shift+Tab
    expect(controller.setRecipient).toHaveBeenLastCalledWith('both');
  });
  it('changes the initial provider before conversation and adds a second provider', async () => {
    const controller = controllerFixture(true);
    const screen = render(<App controller={controller}/>);
    await settle();
    screen.stdin.write('\x07'); await settle(); // Ctrl+G
    screen.stdin.write('\x1b[B'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.setInitialAgent).toHaveBeenCalledWith('claude');
    expect(screen.lastFrame()).toContain('To Claude');
    expect(screen.lastFrame()).not.toContain('Codex');
    screen.stdin.write('/split'); await settle();
    screen.stdin.write('\r'); await settle();
    screen.stdin.write('\r'); await settle();
    expect(controller.addAgent).toHaveBeenCalledWith('codex');
    expect(screen.lastFrame()).toContain('Claude');
    expect(screen.lastFrame()).toContain('Codex');
  });
  it('shows votes from actual same-provider instances', async () => {
    const controller = controllerFixture(true);
    controller.getView().session.agents!.push({ id: 'codex-2', provider: 'codex' });
    controller.getView().session.decisions.push({ id: 'choice', kind: 'decision', title: 'Choice', proposal: 'Discuss', version: 1, tasks: [], positions: { 'codex-2': { version: 1, position: 'object', reason: 'Try another' } }, rounds: 0, status: 'open' });
    const screen = render(<App controller={controller}/>);
    await settle();
    expect(screen.lastFrame()).toContain('Codex 1: pending');
    expect(screen.lastFrame()).toContain('Codex 2: object');
    expect(screen.lastFrame()).not.toContain('Claude:');
  });
});
