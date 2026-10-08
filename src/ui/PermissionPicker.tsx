import React, { useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { PermissionSettings } from '../types.js';
import { permissionLabels, permissionModes } from '../permissions.js';
import { previousCursor } from './composer.js';
import { terminalText } from './text.js';

export function PermissionPicker({ initial, width, height, save, cancel }: {
  initial: PermissionSettings; width: number; height: number;
  save(settings: PermissionSettings): Promise<void>; cancel(): void;
}) {
  const [state, setState] = useState({ settings: structuredClone(initial), path: '', editing: false });
  const current = useRef(state);
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const update = (value: typeof state) => { current.current = value; setState(value); };
  useInput((input, key) => {
    if (saving) return;
    const value = current.current;
    if (key.escape) { if (value.editing) update({ ...value, editing: false }); else cancel(); return; }
    if (value.editing) {
      if (key.return) {
        if (!value.path.trim()) return;
        update({ settings: { ...value.settings, additionalDirectories: [...value.settings.additionalDirectories, value.path.trim()] }, path: '', editing: false });
      } else if (key.backspace || key.delete) update({ ...value, path: value.path.slice(0, previousCursor(value.path, value.path.length)) });
      else if (!key.ctrl && !key.meta && input) update({ ...value, path: (value.path + terminalText(input).replace(/\n/g, '')).slice(0, 4096) });
      return;
    }
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
      const index = permissionModes.indexOf(value.settings.mode);
      update({ ...value, settings: { ...value.settings, mode: permissionModes[(index + (key.upArrow || key.leftArrow ? 2 : 1)) % 3] } });
    } else if (input.toLowerCase() === 'a') update({ ...value, editing: true, path: '' });
    else if (input.toLowerCase() === 'd') update({ ...value, settings: { ...value.settings, additionalDirectories: value.settings.additionalDirectories.slice(0, -1) } });
    else if (key.return) {
      setSaving(true); setError('');
      void save(value.settings).catch(error => { setError(terminalText(error instanceof Error ? error.message : String(error))); setSaving(false); });
    }
  });
  const directories = state.settings.additionalDirectories;
  const visible = Math.max(0, height - 14);
  return <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
    <Text bold color="yellow">Session permissions · both peers</Text>
    <Text dimColor>Saved with the session. Active turns stop when you save.</Text>
    {permissionModes.map(mode => <Text key={mode} color={state.settings.mode === mode ? 'cyan' : undefined}>{state.settings.mode === mode ? '› ' : '  '}{permissionLabels[mode]}</Text>)}
    <Text>{state.settings.mode === 'full' ? 'Full filesystem and network access as your user; no sandbox.' : state.settings.mode === 'project' ? 'Edit the project and added directories. Shell network access stays off.' : 'Read files; project edits and shell commands (Claude) stay disabled.'}</Text>
    <Text dimColor>Direct edits need no plan. Collaboration still uses assigned worktree tasks.</Text>
    <Text>Additional directories ({directories.length}):</Text>
    {(visible ? directories.slice(-visible) : []).map((path, index) => <Text key={index} wrap="truncate">  {terminalText(path)}</Text>)}
    {!directories.length && <Text dimColor>  None · relative paths resolve from the project</Text>}
    {directories.length > visible && <Text dimColor>Earlier entries hidden · /permissions remove PATH removes a specific entry</Text>}
    {state.editing && <Text wrap="truncate">Directory: {state.path}▏</Text>}
    <Text dimColor>Added directories are writable in Project mode and readable in Read-only mode.</Text>
    <Text>{saving ? 'Saving…' : state.editing ? 'Type directory · Enter add · Esc cancel entry' : '↑/↓ mode · A add directory · D remove last · Enter save · Esc cancel'}</Text>
    {error && <Text color="red" wrap="truncate">{error}</Text>}
  </Box>;
}
