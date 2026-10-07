export type SpanKind = 'inline' | 'keyword' | 'string' | 'number' | 'comment' | 'literal' | 'speaker';
export interface StyledSpan { text: string; kind?: SpanKind }

function append(spans: StyledSpan[], text: string, kind?: SpanKind): void {
  if (!text) return;
  const last = spans.at(-1);
  if (last && last.kind === kind) last.text += text;
  else spans.push(kind ? { text, kind } : { text });
}

/** Recognize matching backtick runs without changing unmatched Markdown. */
export function inlineSpans(text: string): StyledSpan[] {
  const spans: StyledSpan[] = [];
  let plainStart = 0;
  const runs = [...text.matchAll(/`+/g)];
  const nextMatching = new Array<number>(runs.length).fill(-1);
  const nextByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i][0].length;
    nextMatching[i] = nextByLength.get(length) ?? -1;
    nextByLength.set(length, i);
  }
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i];
    const closingIndex = nextMatching[i];
    if (closingIndex < 0) continue;
    const closing = runs[closingIndex];
    append(spans, text.slice(plainStart, opening.index));
    append(spans, text.slice(opening.index + opening[0].length, closing.index), 'inline');
    plainStart = closing.index + closing[0].length;
    i = closingIndex;
  }
  append(spans, text.slice(plainStart));
  return spans;
}

type Family = 'js' | 'json' | 'python' | 'shell' | 'c' | 'sql' | 'yaml';
const families: Record<string, Family> = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js',
  json: 'json', jsonc: 'js', py: 'python', python: 'python',
  sh: 'shell', shell: 'shell', bash: 'shell', zsh: 'shell',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cxx: 'c', cs: 'c', csharp: 'c', java: 'c',
  sql: 'sql', yaml: 'yaml', yml: 'yaml',
};
const keywords: Record<Family, Set<string>> = {
  js: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof interface let new of return static super switch this throw try type typeof var void while with yield implements private protected public readonly abstract declare as satisfies'.split(' ')),
  json: new Set(),
  python: new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')),
  shell: new Set('if then else elif fi for while until do done case esac in function select time coproc export local readonly declare return break continue'.split(' ')),
  c: new Set('auto bool break case catch char class const continue default delete do double else enum extern final float for if import int interface long namespace new package private protected public register return short signed sizeof static struct super switch template this throw throws try typedef typename union unsigned using virtual void volatile while'.split(' ')),
  sql: new Set('select from where join inner outer left right full on as insert into values update set delete create table alter drop index distinct group by order having limit offset union all exists between like in is not and or asc desc with case when then else end primary key references nulls'.split(' ')),
  yaml: new Set(),
};
const literals = new Set('true false null undefined None True False nullptr NULL yes no on off'.split(' '));

function quotedEnd(text: string, start: number, quote: string): number {
  let i = start + quote.length;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text.startsWith(quote, i)) {
      // SQL escapes a quote by doubling it.
      if (quote.length === 1 && text.startsWith(quote + quote, i)) { i += 2; continue; }
      return i + quote.length;
    }
    i++;
  }
  return text.length;
}

/** Lightweight lexical colors, not a parser; every source character is retained. */
export function highlightCode(text: string, language: string): StyledSpan[] {
  const label = language.toLowerCase().trim().split(/\s/)[0];
  const family = Object.hasOwn(families, label) ? families[label] : undefined;
  if (!family) return text ? [{ text }] : [];
  const spans: StyledSpan[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let end = i + 1;
    let kind: SpanKind | undefined;
    const slashComments = family === 'js' || family === 'c';
    if ((slashComments && rest.startsWith('//')) || (family === 'sql' && rest.startsWith('--')) ||
        ((family === 'python' || family === 'shell' || family === 'yaml') && rest.startsWith('#'))) {
      const newline = text.indexOf('\n', i);
      end = newline < 0 ? text.length : newline;
      kind = 'comment';
    } else if ((slashComments || family === 'sql') && rest.startsWith('/*')) {
      const close = text.indexOf('*/', i + 2);
      end = close < 0 ? text.length : close + 2;
      kind = 'comment';
    } else if (text[i] === '"' || (family !== 'json' && text[i] === "'") ||
        ((family === 'js' || family === 'shell') && text[i] === '`')) {
      const quote = family === 'python' && (rest.startsWith('"""') || rest.startsWith("'''")) ? rest.slice(0, 3) : text[i];
      end = quotedEnd(text, i, quote);
      kind = 'string';
    } else {
      const identifier = /^[A-Za-z_$][\w$]*/.exec(rest)?.[0];
      if (identifier) {
        end = i + identifier.length;
        const word = family === 'sql' ? identifier.toLowerCase() : identifier;
        if (keywords[family].has(word)) kind = 'keyword';
        else if (literals.has(identifier) || (family === 'sql' && literals.has(word))) kind = 'literal';
      } else {
        const number = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(rest)?.[0];
        if (number) {
          end = i + number.length;
          const invalidSuffix = /^[\w$]+/.exec(text.slice(end))?.[0];
          // Consume malformed tokens once instead of retrying every digit.
          if (invalidSuffix) end += invalidSuffix.length;
          else if (i === 0 || !/[\w$]/.test(text[i - 1])) kind = 'number';
        }
      }
    }
    append(spans, text.slice(i, end), kind);
    i = end;
  }
  return spans;
}
