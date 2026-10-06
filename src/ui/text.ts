/** Provider text is untrusted: terminal escape sequences must never reach Ink. */
export function terminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1bP[\s\S]*?(?:\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[^\n]?/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '  ');
}

/** Bound transcript output before rendering; preserve the latest useful lines. */
export function tailLines(value: string, width: number, count: number, offset = 0): string {
  const chars = Array.from(terminalText(value).slice(-80_000));
  const rows: string[] = [];
  let line = '';
  for (const char of chars) {
    if (char === '\n') { rows.push(line); line = ''; }
    else {
      line += char;
      if (Array.from(line).length >= Math.max(1, width)) { rows.push(line); line = ''; }
    }
  }
  if (line || rows.length === 0) rows.push(line);
  const end = Math.max(0, rows.length - offset);
  return rows.slice(Math.max(0, end - Math.max(1, count)), end).join('\n');
}
