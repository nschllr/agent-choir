import { limitUsage, validLimits } from '../limits.js';
import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize, type DOMElement } from 'ink';
import type { AgentId, Decision, ProviderKind, UIController, ViewState } from '../types.js';
import { agentName, isCollaborating, sessionAgents } from '../agents.js';
import { tailLines, terminalText } from './text.js';
import { inlineSpans } from './code-format.js';
import { historyStart, transcriptRows, visibleCodeBlocks, type HistoryAnchor, type TranscriptRow } from './transcript.js';
import { composerLayout, nextCursor, previousCursor } from './composer.js';
import { containsMouse, type MouseEvents, type MouseEvent, type PaneHandle } from './mouse.js';
import { CopyView, copySnapshot, type CopySnapshot } from './CopyView.js';
import { ModelPicker } from './ModelPicker.js';
import { PermissionPicker } from './PermissionPicker.js';
import { WorkingIndicator } from './WorkingIndicator.js';
import { permissionLabels, permissionModes, sessionPermissions } from '../permissions.js';
import type { ModelSettings } from '../types.js';

export interface AppProps { controller: UIController; onExit?: () => void; mouse?: MouseEvents }
const paneColors = ['cyan', 'magenta'] as const;
const colorFor = (view: ViewState, agent: AgentId) => paneColors[Math.max(0, sessionAgents(view.session).findIndex(item => item.id === agent)) % paneColors.length]!;
const help = 'Ctrl+L permissions · Ctrl+R model · Ctrl+Y copy · Ctrl+F pane · /help';

function StyledRow({ row, agent, view, selected }: { row: TranscriptRow; agent: AgentId; view: ViewState; selected: boolean }) {
  const peer = row.from !== agent && row.from !== 'user' && row.from !== 'system';
  const color = row.from === 'user' ? 'green' : row.from === 'system' ? 'yellow' : peer ? 'gray' : colorFor(view, agent);
  const codeLine = row.code?.part === 'line';
  const syntaxColors = { keyword: 'magentaBright', string: 'greenBright', number: 'yellowBright', comment: 'gray', literal: 'cyanBright' } as const;
  const text = selected && row.code?.part === 'header' ? row.text.replace(/^┌ /, '┌▸') : row.text;
  return <Text color={codeLine ? peer ? 'gray' : 'white' : color} backgroundColor={codeLine ? 'black' : undefined} bold={row.code?.part === 'header' && selected}>
    {(row.spans ?? [{ text }]).map((span, i) => <Text key={i}
      bold={span.kind === 'speaker' || span.kind === 'keyword' || span.kind === 'inline'}
      italic={span.kind === 'comment'} underline={span.kind === 'inline'}
      backgroundColor={span.kind === 'inline' ? 'black' : undefined}
      color={peer ? 'gray' : span.kind === 'inline' ? 'yellow' : span.kind && span.kind in syntaxColors ? syntaxColors[span.kind as keyof typeof syntaxColors] : undefined}>{span.text}</Text>)}
  </Text>;
}

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

const AgentPane = React.memo(function AgentPane({ agent, view, width, height, tools, focused, scrolling, visible, panes }: {
  agent: AgentId; view: ViewState; width: number; height: number; tools: boolean; focused: boolean; scrolling: boolean; visible: boolean;
  panes: Map<AgentId, PaneHandle>;
}) {
  const node = useRef<DOMElement>(null);
  const { session } = view;
  const [anchor, setAnchor] = useState<HistoryAnchor | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const stream = view.streams[agent] || '';
  const previous = useRef<{ stream: string; lastMessage?: string }>({ stream: '' });
  const lastMessage = [...session.messages].reverse().find(message => message.from === agent);
  useEffect(() => {
    const before = previous.current;
    if (before.stream && !stream) {
      const source = `stream:${agent}`;
      const streamed = terminalText(before.stream), final = terminalText(lastMessage?.text ?? '');
      const shift = final && final.startsWith(streamed) ? 0 : final && streamed.endsWith(final) ? final.length - streamed.length
        : streamed && final.endsWith(streamed) ? final.length - streamed.length : undefined;
      const accepted = lastMessage && lastMessage.id !== before.lastMessage && shift !== undefined ? lastMessage.id : undefined;
      const move = (id: string): string | null => {
        if (!id.startsWith(source)) return id;
        if (!accepted) return null;
        let suffix = id.slice(source.length);
        const offset = /^:(code|prose):(\d+)(.*)$/.exec(suffix);
        if (offset) {
          const position = Number(offset[2]) + shift!;
          if (position < 0 && offset[1] !== 'prose') return null;
          suffix = `:${offset[1]}:${Math.max(0, position)}${offset[3]}`;
        }
        return accepted + suffix;
      };
      setExpanded(current => new Set([...current].map(move).filter((id): id is string => id !== null)));
      setSelectedCode(current => current ? move(current) : null);
      setAnchor(current => {
        if (!current) return null;
        const moved = move(current.source);
        if (!moved) return null;
        let offset = current.offset;
        if (current.source.startsWith(source) && shift! < 0) {
          const prose = /^:prose:(\d+)$/.exec(current.source.slice(source.length));
          if (prose && Number(prose[1]) < -shift!) {
            const removed = streamed.slice(Number(prose[1]), -shift!);
            offset = Math.max(0, offset - inlineSpans(removed).reduce((length, span) => length + span.text.length, 0));
          }
        }
        return { ...current, source: moved, offset };
      });
    }
    previous.current = { stream, lastMessage: lastMessage?.id };
  }, [stream, lastMessage?.id, lastMessage?.text, agent]);
  const rows = transcriptRows(session, agent, stream, width - 4, expanded);
  const activity = session.activities.filter(item => item.agent === agent);
  const recent = activity.at(-1);
  const working = view.busy[agent];
  const toolRows = tools ? Math.min(4, Math.max(0, height - (height >= 8 ? 7 : height >= 7 ? 6 : 5))) : 0;
  const count = Math.max(1, height - (height >= 8 ? 6 : height >= 7 ? 5 : 4) - toolRows);
  const start = historyStart(rows, anchor, count);
  const end = Math.min(rows.length, start + count);
  const blocks = visibleCodeBlocks(rows, start, end);
  const target = blocks.find(block => block.id === selectedCode) ?? blocks[0];
  useEffect(() => {
    if (!node.current) return;
    panes.set(agent, { node: node.current, source: () => rows[start]?.source ?? '', scroll: delta => {
      if (!scrolling) return;
      setAnchor(current => {
        const max = Math.max(0, rows.length - count);
        const next = Math.max(0, Math.min(max, historyStart(rows, current, count) + delta));
        const row = rows[next]!;
        return next === max ? null : { source: row.source, offset: row.offset, index: next };
      });
    } });
    return () => { panes.delete(agent); };
  }, [agent, panes, rows, start, count, scrolling]);
  useInput((input, key) => {
    if (key.ctrl && input === 'k') {
      if (target) setSelectedCode(blocks[(blocks.indexOf(target) + 1) % blocks.length].id);
      return;
    }
    if (key.ctrl && input === 'x') {
      if (target) {
        setSelectedCode(target.id);
        setExpanded(current => { const next = new Set(current); if (next.has(target.id)) next.delete(target.id); else next.add(target.id); return next; });
        const header = rows.findIndex(row => row.source === `${target.id}:header`);
        setAnchor({ source: `${target.id}:header`, offset: 0, index: Math.max(0, header) });
      }
      return;
    }
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
  return <Box ref={node} flexDirection="column" width={width} height={height} flexShrink={0} borderStyle={focused ? 'double' : 'round'} borderColor={colorFor(view, agent)} paddingX={1}>
    <Box justifyContent="space-between">
      <Text bold color={colorFor(view, agent)}>{focused ? '▸ ' : ''}{agentName(session, agent)}</Text>
      {!working && <Text dimColor>{session.awaitingInput ? 'ready' : session.finished[agent] ? 'finished' : 'ready'}</Text>}
    </Box>
    {height >= 8 && <Text dimColor wrap="truncate">{session.models?.[agent] ?? 'Native model'} · {session.efforts?.[agent] ?? 'default effort'}{view.busy[agent] ? ' · next turn settings' : ''}</Text>}
    <Box height={count} flexDirection="column" overflow="hidden">
      <Text wrap="truncate">{rows.slice(start, end).map((row, index) => <Text key={`${row.source}:${row.offset}`}>{index ? '\n' : ''}<StyledRow row={row} agent={agent} view={view} selected={focused && row.code?.id === target?.id}/></Text>)}</Text>
    </Box>
    {working ? <WorkingIndicator color={colorFor(view, agent)} activity={height >= 7 ? recent?.text : undefined} animate={visible}/>
      : height >= 7 && <Text dimColor wrap="truncate">{recent ? terminalText(recent.text).replace(/\n/g, ' ') : 'Ready for your message'}</Text>}
    {(height >= 7 || !working) && <Text dimColor wrap="truncate">{target && focused ? `Code ${blocks.indexOf(target) + 1}/${blocks.length} · Ctrl+X ${target.expanded ? 'collapse' : 'expand'}${blocks.length > 1 ? ' · Ctrl+K next' : ''}` : `${start + 1}–${end}/${rows.length} · ${anchor ? 'history · End latest' : 'live · PgUp history'}`}</Text>}
    {tools && <Box height={toolRows} flexDirection="column" borderTop>
      <Text dimColor>{tailLines(activity.map(item => `${item.kind} › ${item.text}`).join('\n') || 'No tool activity yet.', width - 4, toolRows - 1)}</Text>
    </Box>}
  </Box>;
});

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
    <Text bold color={accepted ? 'green' : 'yellow'}>Integration · {integration.status.replace('_', ' ')}</Text>
    <Text dimColor wrap="truncate">{integration.path ? terminalText(integration.path) : 'Preparing the combined candidate'}</Text>
    <Text wrap="truncate">{integration.status === 'waiting_user' ? 'Your decision: /resolve integration <decision>, then /resume' : integration.status === 'review' ? 'Resume for agent integration, or /accept <your validation evidence>' : integration.status === 'conflicts' ? '/resume lets the integration agent resolve conflicts.' : accepted ? terminalText(integration.notes || 'Combined candidate accepted.') : integration.status === 'resolving' ? 'Integration owner is resolving conflicts and validating the combined code.' : integration.status === 'peer_review' ? 'Peer reviews the candidate revision and validation evidence (read-only).' : integration.status === 'consulting' ? 'Peer is answering the integration owner’s question (read-only).' : 'Preparing the combined candidate.'}</Text>
  </Box>;
}

export function App({ controller, onExit, mouse }: AppProps) {
  const view = useView(controller);
  const { exit } = useApp();
  const { columns, rows: terminalRows } = useWindowSize();
  const size = { width: columns, height: terminalRows };
  const [editor, setEditor] = useState({ draft: '', cursor: 0 });
  const editorRef = useRef(editor);
  const { draft, cursor } = editor;
  // Input can arrive several times before React commits a frame. Text and caret
  // must advance together immediately, including when Enter follows a burst.
  const edit = (update: (current: typeof editor) => typeof editor) => {
    editorRef.current = update(editorRef.current);
    setEditor(editorRef.current);
  };
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
  const [copy, setCopy] = useState<CopySnapshot | null>(null);
  const [modelAgent, setModelAgent] = useState<AgentId | null>(null);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const permissions = sessionPermissions(view.session);
  const panes = useRef(new Map<AgentId, PaneHandle>());
  useEffect(() => {
    const receive = (event: MouseEvent) => {
      if (picker || closing || copy || modelAgent || permissionsOpen || event.x >= size.width || event.y >= size.height - 1) return;
      for (const [agent, pane] of panes.current) {
        if (!containsMouse(pane.node, event)) continue;
        if (event.action === 'click') {
          setScrollAgent(agent);
          if (!collaboration) controller.setRecipient(agent);
        } else pane.scroll(event.action === 'up' ? -3 : 3);
        break;
      }
    };
    mouse?.on('mouse', receive);
    return () => { mouse?.off('mouse', receive); };
  }, [mouse, picker, closing, copy, modelAgent, permissionsOpen, collaboration, controller, size]);
  const savePermissions = async (settings: import('../types.js').PermissionSettings) => {
    if (!controller.setPermissions) throw new Error('Permission settings are unavailable in this session.');
    await controller.setPermissions(settings);
    setPermissionsOpen(false);
    setNotice('Permissions saved · Ctrl+P resumes pending work; idle chats accept your next message.');
  };
  const openCopy = () => setCopy(copySnapshot(view.session, focusedAgent, view.streams[focusedAgent] || '', panes.current.get(focusedAgent)?.source()));
  const saveModel = async (agent: AgentId, settings: ModelSettings) => {
    if (!controller.setModelSettings) throw new Error('Model settings are unavailable in this session.');
    await controller.setModelSettings(agent, settings);
    setModelAgent(null);
    setNotice(`${agentName(view.session, agent)} · ${settings.model ?? 'native model'} · ${settings.effort ?? 'default effort'} · applies next turn`);
  };
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
    const text = editorRef.current.draft.trim();
    if (!text) return;
    if (text.startsWith('/')) {
      const [command, ...args] = text.split(/\s+/);
      if (command === '/help') setNotice('Ctrl+L or /permissions: read-only, project, full access; /permissions add|remove PATH. Ctrl+R or /model: model/effort; /effort LEVEL. Ctrl+Y /copy: text selection; Esc returns. Wheel scrolls; click selects a peer. PgUp/PgDn; Home/End; Alt+↑/↓; Ctrl+F pane; Ctrl+X expand code; Ctrl+K next code. Ctrl+B collaboration. /limits [turns N|minutes N] · /chat /split /agent /pause /resume /to /steer /resolve /accept /detach /quit');
      else if (command === '/limits') {
        if (!args.length) setNotice(`Limits per message: ${view.session.maxTurns} turns, ${view.session.maxMinutes} active minutes. /limits turns N or /limits minutes N. New messages reset both counters.`);
        else {
          const limits = { maxTurns: view.session.maxTurns, maxMinutes: view.session.maxMinutes };
          if (args[0] === 'turns') limits.maxTurns = Number(args[1]); else limits.maxMinutes = Number(args[1]);
          if (args.length !== 2 || !['turns', 'minutes'].includes(args[0]) || !validLimits(limits)) {
            setNotice('Use /limits turns N (positive whole number) or /limits minutes N (positive number).'); return;
          }
          if (!controller.setLimits) { setNotice('Limit settings are unavailable for this session.'); return; }
          run(async () => { await controller.setLimits!(limits); setNotice(`Limits: ${limits.maxTurns} turns, ${limits.maxMinutes} active minutes per message. Current usage is preserved; new messages reset it.`); });
        }
      }
      else if (command === '/permissions') {
        if (!args.length) setPermissionsOpen(true);
        else if (args.length === 1 && permissionModes.includes(args[0] as typeof permissions.mode)) run(() => savePermissions({ ...permissions, mode: args[0] as typeof permissions.mode }));
        else if (['add', 'remove'].includes(args[0]) && args.length > 1) {
          const path = args.slice(1).join(' ');
          run(() => savePermissions({ ...permissions, additionalDirectories: args[0] === 'add' ? [...permissions.additionalDirectories, path] : permissions.additionalDirectories.filter(directory => directory !== path) }));
        } else { setNotice('Use /permissions [read-only|project|full], or /permissions add|remove PATH.'); return; }
      }
      else if (command === '/copy') openCopy();
      else if (command === '/model' || command === '/effort') {
        if (!args.length) setModelAgent(focusedAgent);
        else if (args.length === 1) run(() => saveModel(focusedAgent, command === '/model'
          ? { model: args[0] === 'default' ? null : args[0], effort: null }
          : { model: view.session.models?.[focusedAgent] ?? null, effort: args[0] === 'default' ? null : args[0] }));
        else { setNotice('Use /model MODEL_ID or /effort LEVEL for the focused pane. Omit the argument to open the selector.'); return; }
      }
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
    edit(() => ({ draft: '', cursor: 0 }));
  };
  const insert = (text: string) => {
    const clean = terminalText(text);
    edit(({ draft, cursor }) => ({ draft: draft.slice(0, cursor) + clean + draft.slice(cursor), cursor: cursor + clean.length }));
  };
  useInput((input, key) => {
    if (closing) return;
    if (copy) {
      if (key.escape || (key.ctrl && input === 'y')) setCopy(null);
      return;
    }
    if (key.ctrl && input === 'c') { close(); return; }
    if (modelAgent || permissionsOpen) return;
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
    if (key.ctrl && input === 'y') { openCopy(); return; }
    if (key.ctrl && input === 'r') { setModelAgent(focusedAgent); return; }
    if (key.ctrl && input === 'l') { setPermissionsOpen(true); return; }
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
    if (key.leftArrow) { edit(current => ({ ...current, cursor: previousCursor(current.draft, current.cursor) })); return; }
    if (key.rightArrow) { edit(current => ({ ...current, cursor: nextCursor(current.draft, current.cursor) })); return; }
    if (key.ctrl && input === 'a') { edit(current => ({ ...current, cursor: 0 })); return; }
    if (key.ctrl && input === 'e') { edit(current => ({ ...current, cursor: current.draft.length })); return; }
    if (key.ctrl && input === 'u') { edit(() => ({ draft: '', cursor: 0 })); return; }
    if (key.backspace || key.delete) {
      // Terminals often report Backspace as Delete; both erase the previous character.
      edit(current => {
        const previous = previousCursor(current.draft, current.cursor);
        return { draft: current.draft.slice(0, previous) + current.draft.slice(current.cursor), cursor: previous };
      });
      return;
    }
    if (!key.ctrl && !key.meta && !key.escape && input) insert(input);
  });
  const narrow = size.width < 85;
  const decision = view.session.decisions.find(item => item.status === 'waiting_user') ?? view.session.decisions.find(item => item.status === 'open');
  const width = Math.max(24, size.width);
  const paneCount = roster.length + (picker?.mode === 'add' ? 1 : 0);
  const paneWidth = narrow || paneCount === 1 ? width : Math.floor(width / paneCount);
  const composer = composerLayout(draft, cursor, width - 4);
  const composerLines = composer.count;
  const integration = view.session.integration;
  const sessionError = view.session.error ? terminalText(view.session.error).replace(/\n/g, ' ') : '';
  const errorLines = sessionError ? Math.min(4, Math.ceil((sessionError.length + 7) / width)) : 0;
  const reserved = 8 + composerLines + errorLines + (decision ? decision.status === 'waiting_user' ? 7 : 6 : 0) + (integration ? 5 : 0) + (notice ? 1 : 0) + (picker?.mode === 'initial' ? 6 : 0);
  const paneHeight = Math.max(5, Math.floor((size.height - reserved) / (narrow ? paneCount : 1)));
  const usage = limitUsage(view.session);
  const minutes = Math.floor(usage.elapsedMs / 60_000);
  return <><Box display={copy || modelAgent || permissionsOpen ? 'none' : 'flex'} flexDirection="column" width={width} height={Math.max(1, size.height - 1)} overflow="hidden">
    <Box justifyContent="space-between" flexShrink={0}><Text bold wrap="truncate">AGENT DUET <Text dimColor>· {isCollaborating(view.session) ? 'collaborating' : 'chat'} · {permissionLabels[permissions.mode].toLowerCase()}</Text>{view.session.demo && <Text color="yellow"> · OFFLINE DEMO</Text>}</Text><Text color={view.session.status === 'running' ? 'green' : 'yellow'}>{closing === 'close' ? 'pausing and closing' : closing === 'detach' ? 'detaching · work continues' : view.session.awaitingInput ? 'ready' : view.session.status.replace('_', ' ')}</Text></Box>
    <Text dimColor wrap="truncate">{terminalText(view.session.project)} · {terminalText(view.session.id)} · turns {usage.turns}/{view.session.maxTurns} · {minutes}/{view.session.maxMinutes} min</Text>
    <Box flexDirection={narrow ? 'column' : 'row'} flexShrink={0}>
      {roster.map((agent, index) => <AgentPane key={agent.id} agent={agent.id} view={view} width={narrow || paneCount === 1 ? width : index === paneCount - 1 ? width - paneWidth : paneWidth} height={paneHeight} tools={tools} focused={focusedAgent === agent.id} scrolling={!picker && !closing && !copy && !modelAgent && !permissionsOpen} visible={!copy && !modelAgent && !permissionsOpen} panes={panes.current}/>)}
      {picker?.mode === 'add' && <AgentPicker provider={picker.provider} width={narrow ? width : width - paneWidth} height={paneHeight} choosing={choosing}/>}

    </Box>
    {picker?.mode === 'initial' && <AgentPicker provider={picker.provider} width={width} choosing={choosing}/>}
    {decision && <DecisionCard decision={decision} width={width} view={view}/>}
    {integration && <IntegrationCard integration={integration}/>}
    {sessionError && <Box height={errorLines} flexShrink={0} overflow="hidden"><Text color="red">Error: {sessionError}</Text></Box>}
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} flexShrink={0}>
      <Text dimColor wrap="truncate">{collaboration ? <>With <Text bold>{roster.map(agent => agentName(view.session, agent.id)).join(' + ')}</Text> · collaboration ON · Enter submits to both</> : <>To <Text bold color={view.recipient === 'both' ? 'white' : colorFor(view, view.recipient)}>{view.recipient === 'both' ? 'both' : agentName(view.session, view.recipient)}</Text> · direct chat · {view.delivery === 'queued' ? 'wait until tool boundary' : 'steer immediately'}</> }</Text>
      <Text wrap="truncate">{composer.before}<Text inverse>{composer.caret}</Text>{composer.after}</Text>
    </Box>
    {notice && <Text color="yellow" wrap="truncate">{notice}</Text>}
    <Text dimColor wrap="truncate">{view.session.status === 'complete' ? 'Round complete · send a follow-up to continue · /quit or Ctrl+C exits' : help}</Text>
  </Box>{copy && <CopyView snapshot={copy} width={width} height={Math.max(1, size.height - 1)} mouse={mouse}/>}
  {modelAgent && <ModelPicker controller={controller} agent={modelAgent} name={agentName(view.session, modelAgent)} provider={roster.find(agent => agent.id === modelAgent)!.provider}
    initial={{ model: view.session.models?.[modelAgent] ?? null, effort: view.session.efforts?.[modelAgent] ?? null }} width={width} height={Math.max(5, size.height - 1)}
    save={settings => saveModel(modelAgent, settings)} cancel={() => setModelAgent(null)}/>}
  {permissionsOpen && <PermissionPicker initial={permissions} width={width} height={Math.max(5, size.height - 1)} save={savePermissions} cancel={() => setPermissionsOpen(false)}/>}</>;
}
