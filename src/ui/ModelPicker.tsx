import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { AgentId, ModelCatalog, ModelSettings, ProviderKind, UIController } from '../types.js';
import { claudeEfforts, codexEfforts, fallbackCatalog, validModel } from '../model-settings.js';
import { terminalText } from './text.js';

export function ModelPicker({ controller, agent, name, provider, initial, width, height, save, cancel }: {
  controller: UIController; agent: AgentId; name: string; provider: ProviderKind; initial: ModelSettings;
  width: number; height: number; save(settings: ModelSettings): Promise<void>; cancel(): void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>();
  const [model, setModel] = useState<string | null>(initial.model);
  const [effort, setEffort] = useState<string | null>(initial.effort);
  const [editing, setEditing] = useState(false), [custom, setCustom] = useState('');
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void (controller.getModelOptions?.(agent) ?? Promise.resolve(fallbackCatalog(provider))).then(value => {
      if (active) setCatalog(value);
    }, () => { if (active) setCatalog(fallbackCatalog(provider)); });
    return () => { active = false; };
  }, [controller, agent, provider]);
  const options = [{ id: null as string | null, name: 'Native default' }, ...(catalog?.models ?? []).map(item => ({ id: item.id, name: `${item.name} (${item.id})` }))];
  if (model && !options.some(item => item.id === model)) options.push({ id: model, name: `${model} (custom/current)` });
  options.push({ id: '', name: 'Custom model ID…' });
  const index = Math.max(0, options.findIndex(item => item.id === model));
  const selected = catalog?.models.find(item => item.id === (model ?? catalog.defaultModel));
  const efforts: Array<string | null> = [null, ...(selected?.efforts ?? (provider === 'claude' ? claudeEfforts : codexEfforts))];
  const effortIndex = Math.max(0, efforts.indexOf(effort));
  useInput((input, key) => {
    if (key.escape) { if (editing) setEditing(false); else if (!saving) cancel(); return; }
    if (saving || !catalog) return;
    if (editing) {
      if (key.return) {
        if (!validModel(custom)) { setError('Enter a valid model ID (up to 128 characters).'); return; }
        setModel(custom); setEffort(null); setEditing(false); setError('');
      } else if (key.backspace || key.delete) setCustom(value => value.slice(0, -1));
      else if (key.ctrl && input === 'u') setCustom('');
      else if (!key.ctrl && !key.meta && input) setCustom(value => (value + terminalText(input).replace(/\n/g, '')).slice(0, 128));
      return;
    }
    if (key.upArrow || key.downArrow) {
      setModel(options[(index + (key.upArrow ? options.length - 1 : 1)) % options.length].id); setEffort(null); setError('');
    } else if (key.leftArrow || key.rightArrow) {
      setEffort(efforts[(effortIndex + (key.leftArrow ? efforts.length - 1 : 1)) % efforts.length]); setError('');
    } else if (key.return) {
      if (model === '') { setCustom(''); setEditing(true); return; }
      setSaving(true); setError('');
      void save({ model, effort }).catch(error => { setError(terminalText(error instanceof Error ? error.message : String(error))); setSaving(false); });
    }
  });
  const visible = Math.max(1, Math.min(12, height - 10));
  const start = Math.max(0, Math.min(index - visible + 1, options.length - visible));
  return <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
    <Text bold color="yellow" wrap="truncate">Model & reasoning · {name}</Text>
    <Text dimColor wrap="truncate">Changes apply to this peer's next turn and are saved with the session.</Text>
    {!catalog ? <Text>Loading model options…</Text> : <>
      {options.slice(start, start + visible).map(option => <Text key={option.id ?? 'default'} color={option.id === model ? 'cyan' : undefined} wrap="truncate">{option.id === model ? '› ' : '  '}{terminalText(option.name)}</Text>)}
      <Text wrap="truncate">Reasoning effort: <Text bold>{effort ?? 'Native default'}</Text></Text>
      {editing && <Text wrap="truncate">Model ID: {custom}▏</Text>}
      <Text dimColor wrap="truncate">{catalog.notice ?? 'Models and reasoning levels reported by the native CLI.'}</Text>
      <Text wrap="truncate">{saving ? 'Saving…' : editing ? 'Type model ID · Enter confirm · Esc cancel edit' : '↑/↓ model · ←/→ effort · Enter save · Esc cancel'}</Text>
    </>}
    {error && <Text color="red" wrap="truncate">{error}</Text>}
  </Box>;
}
