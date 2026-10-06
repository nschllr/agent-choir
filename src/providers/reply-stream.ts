/** Extracts only the top-level message string from a partial JSON reply. Actions
 * remain private until the complete reply has passed protocol validation. */
export class ReplyMessageStream {
  private buffer = '';
  private emitted = '';
  push(chunk: string): string {
    this.buffer += chunk;
    if (this.buffer.length > 1_000_000) return '';
    let depth = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (char === '{' || char === '[') { depth++; continue; }
      if (char === '}' || char === ']') { depth--; continue; }
      if (char !== '"') continue;
      const start = i;
      for (i++; i < this.buffer.length; i++) {
        if (this.buffer[i] === '\\') { i++; continue; }
        if (this.buffer[i] === '"') break;
      }
      if (i >= this.buffer.length) return '';
      if (depth !== 1) continue;
      let key: string;
      try { key = JSON.parse(this.buffer.slice(start, i + 1)); } catch { return ''; }
      let position = i + 1;
      while (/\s/.test(this.buffer[position] ?? '') && position < this.buffer.length) position++;
      if (this.buffer[position] !== ':') continue;
      position++;
      while (/\s/.test(this.buffer[position] ?? '') && position < this.buffer.length) position++;
      if (key !== 'message' || this.buffer[position] !== '"') continue;
      const valueStart = ++position;
      let safeEnd = valueStart;
      while (position < this.buffer.length) {
        if (this.buffer[position] === '"') break;
        if (this.buffer[position] === '\\') {
          const length = this.buffer[position + 1] === 'u' ? 6 : 2;
          if (position + length > this.buffer.length) break;
          position += length;
        } else position++;
        safeEnd = position;
      }
      try {
        let decoded = JSON.parse('"' + this.buffer.slice(valueStart, safeEnd) + '"') as string;
        // Hold incomplete surrogate pairs until their next chunk arrives.
        if (/[\uD800-\uDBFF]$/.test(decoded)) decoded = decoded.slice(0, -1);
        const delta = decoded.slice(this.emitted.length); this.emitted = decoded; return delta;
      } catch { return ''; }
    }
    return '';
  }
}

/** Claude can stream prose before its schema-constrained result. Delay leading
 * whitespace until the first significant character distinguishes prose/JSON. */
export class ReadableReplyStream {
  private mode: 'pending' | 'prose' | 'json' = 'pending';
  private pending = '';
  private json = new ReplyMessageStream();
  push(chunk: string): string {
    if (this.mode === 'json') return this.json.push(chunk);
    if (this.mode === 'prose') return chunk;
    this.pending += chunk;
    const first = this.pending.trimStart()[0];
    if (!first) return '';
    this.mode = first === '{' ? 'json' : 'prose';
    const initial = this.pending; this.pending = '';
    return this.mode === 'json' ? this.json.push(initial) : initial;
  }
}
