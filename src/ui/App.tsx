import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { AgentId, Decision, ProviderKind, UIController, ViewState } from '../types.js';
import { agentName, isCollaborating, sessionAgents } from '../agents.js';
import { tailLines, terminalText } from './text.js';
import { historyStart, transcriptRows, type HistoryAnchor } from './transcript.js';

export interface AppProps { controller: UIController; onExit?: () => void; }
const paneColors = ['cyan', 'magenta'] as const;
const colorFor = (view: ViewState, agent: AgentId) => paneColors[Math.max(0, sessionAgents(view.session).findIndex(item => item.id === agent)) % paneColors.length]!;
const help = 'PgUp/PgDn scroll · Ctrl+F pane · End latest · Ctrl+B collaboration · /help';

function useView(controller: UIController): ViewState {
  const [view, setView] = useState(() => controller.getView());
  useEffect(() => {
    const refresh = () => setView(controller.getView());
    const unsubscribe = controller.subscribe(refresh);
    refresh();
    return unsubscribe;
  }, [controller]);
  return view;
}

function AgentPane({ agent, view, width, height, tools, focused, scrolling }: {
  agent: AgentId; view: ViewState; width: number; height: number; tools: boolean; focused: boolean; scrolling: boolean;
}) {
  const { session } = view;
  const [anchor, setAnchor] = useState<HistoryAnchor | null>(null);
  const rows = transcriptRows(session, agent, view.streams[agent] || '', width - 4);
  const activity = session.activities.filter(item => item.agent === agent);
  const recent = activity.at(-1);
  const toolRows = tools ? Math.min(4, Math.max(0, height - (height >= 7 ? 6 : 5))) : 0;
  const count = Math.max(1, height - (height >= 7 ? 5 : 4) - toolRows);
  const start = historyStart(rows, anchor, count);
  const end = Math.min(rows.length, start + count);
  useInput((input, key) => {
    const page = Math.max(1, count - 1);
    let next: number;
    if (key.end) { setAnchor(null); return; }
    if (key.home) next = 0;
    else if (key.pageUp) next = start - page;
    else if (key.pageDown) next = start + page;
    else if (key.meta && key.upArrow) next = start - 1;
    else if (key.meta && key.downArrow) next = start + 1;
    else return;
    const max = Math.max(0, rows.length - count);
    next = Math.max(0, Math.min(max, next));
    const row = rows[next]!;
    setAnchor(next === max ? null : { source: row.source, offset: row.offset, index: next });
  }, { isActive: focused && scrolling });
  return <Box flexDirection="column" width={width} height={height} borderStyle={focused ? 'double' : 'round'} borderColor={colorFor(view, agent)} paddingX={1}>
    <Box justifyContent="space-between">
      <Text bold color={colorFor(view, agent)}>{focused ? '▸ ' : ''}{agentName(session, agent)}</Text>
      <Text dimColor>{view.busy[agent] ? 'working' : session.awaitingInput ? 'ready' : session.finished[agent] ? 'finished' : 'ready'}</Text>
    </Box>
    {height >= 7 && <Text dimColor wrap="truncate">{recent ? terminalText(recent.text).replace(/\n/g, ' ') : 'Ready for your message'}</Text>}
    <Box height={count} flexDirection="column" overflow="hidden">
      <Text wrap="truncate">{rows.slice(start, end).map((row, index) => <Text key={`${row.source}:${row.offset}`} color={row.from === 'user' ? 'green' : row.from === 'system' ? 'yellow' : colorFor(view, row.from)}>{index ? '\n' : ''}{row.prefix ? <><Text bold>{row.text.slice(0, row.prefix.length)}</Text>{row.text.slice(row.prefix.length)}</> : row.text}</Text>)}</Text>
    </Box>
    <Text dimColor wrap="truncate">{start + 1}–{end}/{rows.length} · {anchor ? 'history · End latest' : 'live · PgUp history'}</Text>
    {tools && <Box height={toolRows} flexDirection="column" borderTop>
      <Text dimColor>{tailLines(activity.map(item => `${item.kind} › ${item.text}`).join('\n') || 'No tool activity yet.', width - 4, toolRows - 1)}</Text>
    </Box>}
  </Box>;
}

function DecisionCard({ decision, width, view }: { decision: Decision; width: number; view: ViewState }) {
  const position = (agent: AgentId) => {
    const recorded = decision.positions[agent];
    return recorded && recorded.version === decision.version ? `${recorded.position}${recorded.reason ? `: ${terminalText(recorded.reason)}` : ''}` : 'pending';
  };
  return <Box flexDirection="column" borderStyle="single" borderColor={decision.status === 'waiting_user' ? 'yellow' : 'gray'} paddingX={1}>
    <Text bold color={decision.status === 'waiting_user' ? 'yellow' : undefined} wrap="truncate">
      {terminalText(decision.id)} · v{decision.version} · {terminalText(decision.title)} · {decision.status.replace('_', ' ')}
    </Text>
    <Text dimColor>{tailLines(decision.proposal, width - 4, 2)}</Text>
    <Text wrap="truncate">{sessionAgents(view.session).map((agent, index) => <Text key={agent.id} color={colorFor(view, agent.id)}>{index ? ' · ' : ''}{agentName(view.session, agent.id)}: {position(agent.id)}</Text>)}</Text>
    {decision.status === 'waiting_user' && <Text color="yellow" wrap="truncate">Your decision: /resolve {terminalText(decision.id)} &lt;resolution&gt;</Text>}
  </Box>;
}


function AgentPicker({ provider, width, height, choosing }: { provider: ProviderKind; width: number; height?: number; choosing: boolean }) {
  return <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width} height={height}>
    <Text bold color="yellow">Choose agent</Text>
    <Text color={provider === 'codex' ? 'cyan' : undefined}>{provider === 'codex' ? '›' : ' '} Codex</Text>
    <Text color={provider === 'claude' ? 'magenta' : undefined}>{provider === 'claude' ? '›' : ' '} Claude</Text>
    <Text dimColor>{choosing ? 'Adding agent…' : '↑/↓ select · Enter confirm · Esc cancel'}</Text>
  </Box>;
}

function IntegrationCard({ integration }: { integration: NonNullable<ViewState['session']['integration']> }) {
  const accepted = integration.status === 'accepted';
  return <Box flexDirection="column" borderStyle="single" borderColor={accepted ? 'green' : 'yellow'} paddingX={1}>
    <Text bold color={accepted ? 'green' : 'yellow'}>Integration checkpoint · {integration.status}</Text>
    <Text dimColor wrap="truncate">{integration.path ? terminalText(integration.path) : 'Preparing the combined candidate'}</Text>
    <Text wrap="truncate">{integration.status === 'review' ? 'Inspect and test the candidate, then /accept <validation evidence>' : integration.status === 'conflicts' ? 'Resolve integration conflicts before acceptance.' : accepted ? terminalText(integration.notes || 'Combined candidate accepted.') : 'Completion awaits combined validation.'}</Text>
  </Box>;
}

export function App({ controller, onExit }: AppProps) {
  const view = useView(controller);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 100, height: stdout.rows || 32 });
  const [draft, setDraft] = useState('');
  const [cursor, setCursor] = useState(0);
  const [tools, setTools] = useState(false);
  const [scrollAgent, setScrollAgent] = useState(() => sessionAgents(view.session)[0]!.id);
  const [notice, setNotice] = useState('');
  const [collaboration, setCollaboration] = useState(() => isCollaborating(view.session));
  const [resumeAfterToggle, setResumeAfterToggle] = useState(false);
  const modeTransition = useRef<Promise<void>>(Promise.resolve());
  const [picker, setPicker] = useState<{ mode: 'add' | 'initial'; provider: ProviderKind } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const roster = sessionAgents(view.session);
  const focusedAgent = roster.some(agent => agent.id === scrollAgent) ? scrollAgent : roster[0]!.id;
  const [closing, setClosing] = useState<'close' | 'detach' | null>(null);
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 100, height: stdout.rows || 32 });
    stdout.on('resize', resize);
    return () => { stdout.off('resize', resize); };
  }, [stdout]);
  const run = (action: () => Promise<void>) => { void action().catch(error => setNotice(terminalText(error instanceof Error ? error.message : String(error)))); };
  const close = () => {
    if (closing) return;
    setClosing('close');
    void controller.close().then(() => { if (onExit) onExit(); else exit(); }).catch(error => { setClosing(null); setNotice(terminalText(String(error))); });
  };
  const detach = () => {
    if (!controller.detach) { setNotice('Background execution is unavailable here. Start using --detach, then attach to the session.'); return; }
    if (closing) return;
    setClosing('detach');
    void controller.detach().then(() => { if (onExit) onExit(); else exit(); }).catch(error => { setClosing(null); setNotice(terminalText(String(error))); });
  };
  const togglePause = () => { setResumeAfterToggle(false); run(() => view.session.status === 'running' ? controller.pause() : controller.start()); };
  const openPicker = (mode: 'add' | 'initial') => {
    if (mode === 'add' && roster.length >= 2) { setNotice('Two agents are already present. Tab chooses the recipient.'); return; }
    if (mode === 'initial' && (roster.length !== 1 || view.session.messages.length > 0 || view.session.turns > 0)) { setNotice('Choose the initial agent before sending a message.'); return; }
    setNotice(''); setPicker({ mode, provider: 'codex' });
  };
  const chooseProvider = (provider: ProviderKind, mode: 'add' | 'initial') => {
    const action = mode === 'add' ? controller.addAgent : controller.setInitialAgent;
    if (!action) { setNotice('Agent selection is unavailable for this session.'); return; }
    setChoosing(true);
    void action.call(controller, provider).then(() => { setPicker(null); setNotice(''); }).catch(error => setNotice(terminalText(error instanceof Error ? error.message : String(error)))).finally(() => setChoosing(false));
  };
  const canCollaborate = () => {
    if (roster.length !== 2) { setNotice('Add a second agent with Ctrl+N before starting collaboration.'); return false; }
    if (!controller.collaborate) { setNotice('Collaboration is unavailable for this session.'); return false; }
    return true;
  };
  const selectCollaboration = (enabled: boolean) => {
    if (enabled && !canCollaborate()) return false;
    setCollaboration(enabled);
    setNotice(enabled ? 'Collaboration ON · type a task and press Enter. Both agents will exchange replies.' : 'Direct chat · Enter sends only to the selected recipient.');
    if (!enabled && isCollaborating(view.session) && view.session.status === 'running') {
      setResumeAfterToggle(true);
      modeTransition.current = controller.pause();
      run(() => modeTransition.current);
    }
    return true;
  };
  const collaborate = (text: string) => {
    if (!text.trim()) { setNotice('Write a task and press Enter to start collaboration.'); return false; }
    if (!canCollaborate()) return false;
    setCollaboration(true); setResumeAfterToggle(false);
    setNotice('');
    run(async () => { await modeTransition.current; await controller.collaborate!(text.trim()); });
    return true;
  };
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      const [command, ...args] = text.split(/\s+/);
      if (command === '/help') setNotice('PgUp/PgDn scroll; Home/End oldest/latest; Alt+↑/↓ one line; Ctrl+F scroll pane. Ctrl+B toggles collaboration; Enter submits. /collaborate [TASK] /chat /split [codex|claude] /agent [codex|claude] /pause /resume /to <agent name>|both /steer queued|immediate /resolve ID resolution /accept evidence /detach /quit');
      else if (command === '/collaborate') {
        if (args.length ? !collaborate(args.join(' ')) : !selectCollaboration(true)) return;
      }
      else if (command === '/chat') selectCollaboration(false);
      else if (command === '/split' || command === '/agent') {
        const mode = command === '/split' ? 'add' : 'initial';
        if (!args.length) openPicker(mode);
        else if (args.length === 1 && ['codex', 'claude'].includes(args[0]!)) {
          if (mode === 'add' && roster.length >= 2) setNotice('Two agents are already present.');
          else if (mode === 'initial' && (roster.length !== 1 || view.session.messages.length > 0 || view.session.turns > 0)) setNotice('Choose the initial agent before sending a message.');
          else chooseProvider(args[0] as ProviderKind, mode);
        } else { setNotice('Choose codex or claude.'); return; }
      }
      else if (command === '/pause') { setResumeAfterToggle(false); run(() => controller.pause()); }
      else if (command === '/resume') run(() => controller.start());
      else if (command === '/quit') close();
      else if (command === '/detach') detach();
      else if (command === '/accept' && args.length >= 1) {
        if (controller.acceptIntegration) run(() => controller.acceptIntegration!(args.join(' ')));
        else setNotice('Integration acceptance is unavailable for this session.');
      }
      else if (command === '/to' && args.length) {
        const requested = args.join(' ').toLowerCase();
        const recipient = roster.find(agent => agent.id.toLowerCase() === requested || agentName(view.session, agent.id).toLowerCase() === requested);
        if (collaboration) { setNotice('Collaboration includes both agents. Use Ctrl+B or /chat for direct recipients.'); return; }
        if (requested === 'both' && roster.length === 2) controller.setRecipient('both');
        else if (recipient) controller.setRecipient(recipient.id);
        else setNotice(`Choose ${roster.map(agent => agentName(view.session, agent.id)).join(', ')}${roster.length === 2 ? ', or both' : ''}.`);
      }
      else if (command === '/steer' && args.length === 1 && ['queued', 'immediate'].includes(args[0]!)) controller.setDelivery(args[0] as 'queued' | 'immediate');
      else if (command === '/resolve' && args.length >= 2) run(() => controller.resolve(args[0]!, args.slice(1).join(' ')));
      else { setNotice('Unknown command or missing argument. /help lists commands.'); return; }
    } else if (collaboration) {
      if (!collaborate(text)) return;
    } else {
      setNotice('');
      const continueConversation = resumeAfterToggle || view.session.status === 'complete' || view.session.awaitingInput === true;
      setResumeAfterToggle(false);
      run(async () => {
        await modeTransition.current;
        await controller.send(text, view.recipient, view.delivery);
        // Idle conversations begin on submission; an explicit pause keeps messages queued.
        if (continueConversation) await controller.start();
      });
    }
    setDraft(''); setCursor(0);
  };
  const insert = (text: string) => {
    const clean = terminalText(text);
    setDraft(current => current.slice(0, cursor) + clean + current.slice(cursor));
    setCursor(current => current + clean.length);
  };
  useInput((input, key) => {
    if (closing) return;
    if (key.ctrl && input === 'c') { close(); return; }
    if (picker) {
      if (choosing) return;
      if (key.escape) { setPicker(null); return; }
      if (key.upArrow || key.downArrow || key.tab) { setPicker(current => current && { ...current, provider: current.provider === 'codex' ? 'claude' : 'codex' }); return; }
      if (key.return) { chooseProvider(picker.provider, picker.mode); return; }
      if (input === '1') setPicker(current => current && { ...current, provider: 'codex' });
      if (input === '2') setPicker(current => current && { ...current, provider: 'claude' });
      return;
    }
    if (key.ctrl && input === 'n') { openPicker('add'); return; }
    if (key.ctrl && input === 'g') { openPicker('initial'); return; }
    if (key.ctrl && input === 'b') {
      selectCollaboration(!collaboration);
      return;
    }
    if (key.ctrl && input === 'p') { togglePause(); return; }
    if (key.ctrl && input === 's') { controller.setDelivery(view.delivery === 'queued' ? 'immediate' : 'queued'); return; }
    if (key.ctrl && input === 'o') { setTools(value => !value); return; }
    if (key.ctrl && input === 'f') {
      const current = roster.findIndex(agent => agent.id === focusedAgent);
      setScrollAgent(roster[(current + 1) % roster.length]!.id);
      return;
    }
    if (key.tab) {
      if (collaboration) { setNotice('Collaboration includes both agents. Use Ctrl+B or /chat for direct recipients.'); return; }
      const recipients = roster.length === 2 ? ['both', ...roster.map(agent => agent.id)] : roster.map(agent => agent.id);
      const current = Math.max(0, recipients.indexOf(view.recipient));
      controller.setRecipient(recipients[(current + (key.shift ? recipients.length - 1 : 1)) % recipients.length]!);
      return;
    }
    if ((key.return && key.meta) || (key.ctrl && input === 'j') || input === '\n') { insert('\n'); return; }
    if (key.return) { submit(); return; }
    if (key.leftArrow) { setCursor(value => Math.max(0, value - 1)); return; }
    if (key.rightArrow) { setCursor(value => Math.min(draft.length, value + 1)); return; }
    if (key.ctrl && input === 'a') { setCursor(0); return; }
    if (key.ctrl && input === 'e') { setCursor(draft.length); return; }
    if (key.ctrl && input === 'u') { setDraft(''); setCursor(0); return; }
    if (key.backspace || key.delete) {
      // Terminals often report Backspace as Delete; both erase the previous character.
      if (cursor > 0) { setDraft(value => value.slice(0, cursor - 1) + value.slice(cursor)); setCursor(value => value - 1); }
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape && input) insert(input);
  });
  const narrow = size.width < 85;
  const decision = view.session.decisions.find(item => item.status === 'waiting_user') ?? view.session.decisions.find(item => item.status === 'open');
  const width = Math.max(24, size.width);
  const paneCount = roster.length + (picker?.mode === 'add' ? 1 : 0);
  const paneWidth = narrow || paneCount === 1 ? width : Math.floor(width / paneCount);
  const composerLines = Math.min(4, draft.split('\n').length);
  const integration = view.session.integration;
  const reserved = 8 + composerLines + (decision ? decision.status === 'waiting_user' ? 7 : 6 : 0) + (integration ? 5 : 0) + (notice ? 1 : 0) + (picker?.mode === 'initial' ? 6 : 0);
  const paneHeight = Math.max(5, Math.floor((size.height - reserved) / (narrow ? paneCount : 1)));
  const minutes = Math.floor(view.session.elapsedMs / 60_000);
  return <Box flexDirection="column" width={width}>
    <Box justifyContent="space-between"><Text bold>AGENT DUET <Text dimColor>· {isCollaborating(view.session) ? 'collaborating' : 'chat'} · {view.session.scope === 'build' && !view.session.demo ? 'edits enabled' : 'read-only'}</Text>{view.session.demo && <Text color="yellow"> · OFFLINE DEMO</Text>}</Text><Text color={view.session.status === 'running' ? 'green' : 'yellow'}>{closing === 'close' ? 'pausing and closing' : closing === 'detach' ? 'detaching · work continues' : view.session.awaitingInput ? 'ready' : view.session.status.replace('_', ' ')}</Text></Box>
    <Text dimColor wrap="truncate">{terminalText(view.session.project)} · {terminalText(view.session.id)} · turns {view.session.turns}/{view.session.maxTurns} · {minutes}/{view.session.maxMinutes} min</Text>
    <Box flexDirection={narrow ? 'column' : 'row'}>
      {roster.map((agent, index) => <AgentPane key={agent.id} agent={agent.id} view={view} width={narrow || paneCount === 1 ? width : index === paneCount - 1 ? width - paneWidth : paneWidth} height={paneHeight} tools={tools} focused={focusedAgent === agent.id} scrolling={!picker && !closing}/>)}
      {picker?.mode === 'add' && <AgentPicker provider={picker.provider} width={narrow ? width : width - paneWidth} height={paneHeight} choosing={choosing}/>}

    </Box>
    {picker?.mode === 'initial' && <AgentPicker provider={picker.provider} width={width} choosing={choosing}/>}
    {decision && <DecisionCard decision={decision} width={width} view={view}/>}
    {integration && <IntegrationCard integration={integration}/>}
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text dimColor>{collaboration ? <>With <Text bold>{roster.map(agent => agentName(view.session, agent.id)).join(' + ')}</Text> · collaboration ON · Enter submits to both</> : <>To <Text bold color={view.recipient === 'both' ? 'white' : colorFor(view, view.recipient)}>{view.recipient === 'both' ? 'both' : agentName(view.session, view.recipient)}</Text> · direct chat · {view.delivery === 'queued' ? 'wait until tool boundary' : 'steer immediately'}</> }</Text>
      <Text>{tailLines(`› ${draft.slice(0, cursor)}▏${draft.slice(cursor)}`, width - 4, composerLines)}</Text>
    </Box>
    {notice && <Text color="yellow" wrap="truncate">{notice}</Text>}
    <Text dimColor wrap="truncate">{view.session.status === 'complete' ? 'Round complete · send a follow-up to continue · /quit or Ctrl+C exits' : help}</Text>
  </Box>;
}
