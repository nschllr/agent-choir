#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { closeSync, mkdirSync, openSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createSession } from './engine.js';
import { SessionStore } from './store.js';
import { DuetController } from './controller.js';
import { GitWorkspaceManager } from './workspaces.js';
import { DemoProvider } from './demo.js';
import { ClaudeProvider, CodexProvider } from './providers/index.js';
import { App } from './ui/App.js';
import { agentName, isProvider, sessionAgents } from './agents.js';
import { terminalText } from './ui/text.js';
import { connectController, serveController } from './background.js';
import type { AgentConfig, AgentProvider, ProviderKind, Scope, UIController } from './types.js';

const HELP = `Agent Duet — two equal agents, one local workspace

Usage:
  agent-duet                                Open an empty Codex chat
  agent-duet --agent claude                  Start with Claude instead
  agent-duet --agent codex --peer codex      Open two separate Codex instances
  agent-duet --demo                         Offline, clearly labelled simulation
  agent-duet --project PATH "Discuss, plan, or implement a feature"
  agent-duet --read-only "Explore an approach without editing files"
  agent-duet --resume ID                    Open a saved session, paused
  agent-duet --detach [other options]       Start an intentional background worker
  agent-duet --attach ID                    Reattach to a running worker
  agent-duet --list                         List saved sessions
  agent-duet --doctor                       Inspect local prerequisites, no model calls

Options:
  --read-only                 Prevent project edits (default permits approved implementation)
  --agent codex|claude          Initial provider (default Codex)
  --peer codex|claude           Optional second provider
  --collaborate                Explicitly start autonomous work on the supplied brief
  --brief TEXT                 Task text (alternative to positional text)
  --headless                   Run to completion/checkpoint without terminal UI
  --json                       Headless final snapshot as JSON
  --state-dir PATH             Private local state directory
  --max-turns N                Session allowance (default 30)
  --max-minutes N              Active-time allowance (default 30)
  --claude-model MODEL         Claude model alias or ID (saved with session)
  --codex-model MODEL          Codex model ID (saved with session)

Controls:
  Ctrl+N add agent · Ctrl+G initial agent · Tab recipient · Ctrl+S steering
  Ctrl+B toggle collaboration · Ctrl+P pause/resume · Ctrl+O tools
  Enter send · Alt+Enter/Ctrl+J newline · Ctrl+C pause/exit
  PgUp/PgDn scroll · Alt+Up/Down one line · Home/End oldest/latest · Ctrl+F scroll pane
  /help /split /agent /collaborate [TASK] /chat /pause /resume /to /steer /resolve ID choice /accept evidence /detach /quit

Native logins: run codex login and claude in your own terminal. Agent Duet never
reads or copies credentials. Live sessions consume the providers' normal usage.
Build work remains on isolated branches; combined validation is a user checkpoint.
`;

function positive(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value); if (!Number.isFinite(n) || n <= 0 || (label === '--max-turns' && !Number.isSafeInteger(n))) throw new Error(`${label} must be a positive${label === '--max-turns' ? ' integer' : ' number'}`); return n;
}
function modelOption(value: string | undefined, label: string): string | undefined {
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value)) throw new Error(`${label} must be a nonempty model alias or ID (up to 128 characters)`);
  return value;
}
function doctor(): void {
  console.log(`Agent Duet · Node ${process.version} · ${process.platform}`);
  for (const [binary, args] of [['codex', ['--version']], ['claude', ['--version']], ['git', ['--version']], ['bwrap', ['--version']], ['socat', ['-V']]] as const) {
    try { const result = execFileSync(binary, [...args], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }); console.log(`${binary}: ${terminalText(result.split('\n')[0])}`); }
    catch { console.log(`${binary}: unavailable (or cannot execute in this environment)`); }
  }
  console.log('No logins inspected and no model requests made. Claude build mode requires native sandbox support; missing support fails closed.');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    demo: { type: 'boolean' }, headless: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    doctor: { type: 'boolean' }, list: { type: 'boolean' }, detach: { type: 'boolean' }, 'worker-start': { type: 'boolean' },
    project: { type: 'string' }, scope: { type: 'string' }, 'read-only': { type: 'boolean' }, brief: { type: 'string' }, resume: { type: 'string' }, attach: { type: 'string' }, worker: { type: 'string' },
    'state-dir': { type: 'string' }, 'max-turns': { type: 'string' }, 'max-minutes': { type: 'string' },
    'claude-model': { type: 'string' }, 'codex-model': { type: 'string' },
    agent: { type: 'string' }, peer: { type: 'string' },
    collaborate: { type: 'boolean' },
  } });
  if (values.help) { console.log(HELP); return; }
  if (values.doctor) { doctor(); return; }
  if (values.scope !== undefined && !['discuss', 'plan', 'build'].includes(values.scope)) throw new Error('Legacy --scope must be discuss, plan, or build; use --read-only to prevent edits');
  if (values['read-only'] && values.scope === 'build') throw new Error('--read-only cannot be combined with --scope build');
  if ((values.resume || values.attach || values.worker) && (values['read-only'] || values.scope !== undefined)) throw new Error('Saved sessions retain their permissions. Start a new session to change them.');
  for (const key of ['agent', 'peer'] as const) if (values[key] !== undefined && !isProvider(values[key])) throw new Error(`--${key} must be codex or claude`);
  if ((values.resume || values.attach || values.worker) && (values.agent || values.peer)) throw new Error('Saved sessions keep their agent instances; use the in-app agent picker to add a peer');
  if (values.collaborate && (values.resume || values.attach || values.worker)) throw new Error('Use /collaborate TASK in a saved session to start a new shared task');
  const selectedModels = { claude: modelOption(values['claude-model'], '--claude-model'), codex: modelOption(values['codex-model'], '--codex-model') };
  if (values.attach && Object.values(selectedModels).some(model => model !== undefined)) throw new Error('Model overrides require --resume or a new session; --attach uses the running worker’s saved models');
  const stateDir = resolve(values['state-dir'] ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'agent-duet'));
  if (values.attach) {
    const remote = await connectController(stateDir, values.attach);
    remote.detach = async () => remote.disconnect();
    const screen = render(<App controller={remote} />, { exitOnCtrlC: false });
    try { await screen.waitUntilExit(); } finally { remote.disconnect(); }
    return;
  }
  const store = new SessionStore(stateDir);
  if (values.list) { try { console.log(values.json ? JSON.stringify(store.list(), null, 2) : store.list().map(s => `${s.id}  ${s.status.padEnd(12)} ${s.demo ? 'demo' : s.scope === 'build' ? 'edits enabled' : 'read-only'}  ${terminalText(s.brief).replace(/\n/g, ' ').slice(0, 70)}`).join('\n') || 'No saved sessions.'); } finally { store.close(); } return; }
  let release: (() => void) | undefined;
  let controller: DuetController | undefined;
  let server: Awaited<ReturnType<typeof serveController>> | undefined;
  const cleanup = async () => { await server?.close(); await controller?.close(); release?.(); store.close(); };
  try {
    const resume = values.worker ?? values.resume;
    let session;
    if (resume) {
      release = store.acquire(resume); session = store.load(resume);
      if (!session) throw new Error(`Unknown session: ${resume}`);
    } else {
      const project = realpathSync(resolve(values.project ?? process.cwd()));
      if (!statSync(project).isDirectory()) throw new Error('Project must be a directory');
      let brief = values.brief ?? positionals.join(' ');
      const scriptedPair = values.demo && !values.agent && !values.peer;
      if (scriptedPair) brief = 'Explore how two equal agents can collaborate reliably in a local terminal. [Offline scripted demonstration]';
      if (!brief.trim() && (values.headless || values.detach || !process.stdout.isTTY)) throw new Error('Provide a task brief for headless/background execution. Start in a terminal for an empty chat.');
      const scope = values.scope ?? (values['read-only'] || values.demo ? 'discuss' : 'build');
      if (values.demo && scope === 'build') throw new Error('The offline demonstration supports discuss/plan only and never edits files');
      const agents: AgentConfig[] | undefined = scriptedPair ? undefined : [{ id: 'agent-1', provider: (values.agent ?? 'codex') as ProviderKind }, ...(values.peer ? [{ id: 'agent-2', provider: values.peer as ProviderKind }] : [])];
      if (values.collaborate && (!brief.trim() || (agents && agents.length < 2))) throw new Error('--collaborate requires --peer and a nonempty task brief');
      session = createSession({ project, scope: scope as Scope, brief, agents, interaction: values.collaborate ? 'collaborate' : undefined, demo: values.demo, maxTurns: positive(values['max-turns'], '--max-turns'), maxMinutes: positive(values['max-minutes'], '--max-minutes') });
      release = store.acquire(session.id); store.save(session);
    }
    if (values['max-turns']) session.maxTurns = positive(values['max-turns'], '--max-turns')!;
    if (values['max-minutes']) session.maxMinutes = positive(values['max-minutes'], '--max-minutes')!;
    for (const provider of ['claude', 'codex'] as const) if (selectedModels[provider] !== undefined) {
      session.providerModels = { ...session.providerModels, [provider]: selectedModels[provider] };
      for (const agent of sessionAgents(session).filter(agent => agent.provider === provider)) session.models = { ...session.models, [agent.id]: selectedModels[provider] };
    }
    const factory = (agent: AgentConfig): AgentProvider => {
      if (session.demo) return new DemoProvider(agent.id);
      const native = agent.provider === 'claude' ? new ClaudeProvider() : new CodexProvider();
      return { id: agent.id, run: native.run.bind(native), dispose: native.dispose.bind(native) };
    };
    controller = new DuetController(session, Object.fromEntries(sessionAgents(session).map(agent => [agent.id, factory(agent)])), store, new GitWorkspaceManager(stateDir), factory);
    const launchWorker = async () => {
      const autoStart = values.detach || controller!.getView().session.status === 'running';
      await controller!.close(); release?.(); release = undefined; store.close();
      const logs = join(stateDir, 'logs'); mkdirSync(logs, { recursive: true, mode: 0o700 });
      const fd = openSync(join(logs, `${session.id}.log`), 'a', 0o600);
      const child = spawn(process.execPath, [...process.execArgv, process.argv[1], '--worker', session.id, '--state-dir', stateDir, ...(autoStart ? ['--worker-start'] : [])], { detached: true, stdio: ['ignore', fd, fd], env: process.env });
      closeSync(fd);
      await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) break;
        try { const probe = await connectController(stateDir, session.id); probe.disconnect(); ready = true; break; }
        catch { await new Promise(resolve => setTimeout(resolve, 50)); }
      }
      if (!ready) {
        // ChildProcess retains process identity; only terminate the worker we launched.
        child.kill('SIGTERM');
        throw new Error(`Background worker did not become ready. Inspect ${join(logs, `${session.id}.log`)}`);
      }
      console.log(`Detached session ${session.id}\nReattach: agent-duet --state-dir ${JSON.stringify(stateDir)} --attach ${session.id}`);
    };
    if (values.detach) { await launchWorker(); return; }
    if (values.worker) {
      server = await serveController(controller, stateDir, session.id);
      const shutdown = async () => { await cleanup(); process.exit(0); };
      process.once('SIGTERM', () => void shutdown()); process.once('SIGINT', () => void shutdown());
      if (values['worker-start'] && !session.decisions.some(d => d.status === 'waiting_user') && !session.integration) await controller.start();
      await new Promise<void>(() => {}); // The socket serves paused/completed sessions until explicitly stopped.
    } else if (values.headless || !process.stdout.isTTY) {
      if (!values.headless) console.error('Agent Duet: output is not an interactive terminal; running headless and exiting at completion. Run in an interactive terminal for the split view, or use --headless explicitly.');
      let shown = 0;
      const print = () => {
        const view = controller!.getView();
        if (!values.json) for (const m of view.session.messages.slice(shown)) console.log(`[${agentName(view.session, m.from)}] ${terminalText(m.text)}`);
        shown = view.session.messages.length;
      };
      const unsubscribe = controller.subscribe(print);
      const interrupted = () => void controller!.pause(); process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      print(); await controller.start(); await controller.wait(); unsubscribe();
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
      const final = controller.getView().session;
      console.log(values.json ? JSON.stringify(final, null, 2) : `\n${final.status} · ${final.turns} turns · session ${final.id}${final.error ? `\n${terminalText(final.error)}` : ''}`);
      if (final.status === 'error') process.exitCode = 1;
    } else {
      const local: UIController = controller;
      local.detach = launchWorker;
      // Keep terminal input live while the composer waits for a first/follow-up message.
      process.stdin.resume();
      const screen = render(<App controller={local} />, { exitOnCtrlC: false });
      if (!resume && session.brief.trim()) await controller.start();
      await screen.waitUntilExit();
    }
  } finally { await cleanup(); process.stdin.pause(); }
}
main().catch(error => { console.error(`Agent Duet: ${terminalText(error instanceof Error ? error.message : String(error))}`); process.exitCode = 1; });
