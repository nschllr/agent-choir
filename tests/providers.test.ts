import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider, CodexProvider } from '../src/providers/index.js';
import type { ProviderEvent, ProviderTurn } from '../src/types.js';
import { SUPERVISOR_SOURCE } from '../src/providers/supervisor.js';

const dirs: string[] = [];
async function fixture(code: string) {
  const cwd = await mkdtemp(join(tmpdir(), 'duet-provider-')); dirs.push(cwd);
  const script = join(cwd, 'fake.cjs'); await writeFile(script, `if(process.argv.includes('auth')&&process.argv.includes('status')){console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}\n` + code);
  return { cwd, options: { binary: process.execPath, prefixArgs: [script] } };
}
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const turn = (cwd: string, extra: Partial<ProviderTurn> = {}): ProviderTurn => ({ agent: 'codex', cwd, writable: false, prompt: 'Discuss the project', signal: new AbortController().signal, ...extra });
const codexFixture = `
const readline = require('node:readline');
const send = v => process.stdout.write(JSON.stringify(v)+'\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 if(m.method==='account/read') send({id:m.id,result:{account:{type:'chatgpt'}}});
 if(m.method==='config/read') send({id:m.id,result:{config:{}}});
 if(m.method==='model/list') send({id:m.id,result:{data:[{model:'fixture-codex',displayName:'Fixture Codex',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'},{reasoningEffort:'high'}]}],nextCursor:null}});
 if(m.method==='thread/start'||m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId||'session-1'}}});
 if(m.method==='thread/name/set') send({id:m.id,result:{}});
 if(m.method==='turn/start') {
  const p=m.params;
  const safe=p.approvalPolicy==='never' && p.outputSchema.type==='object' &&
    (p.sandboxPolicy.type==='readOnly'||(p.sandboxPolicy.type==='workspaceWrite'&&p.sandboxPolicy.writableRoots[0]===p.cwd));
  send({id:m.id,result:{turn:{id:'turn-1'}}});
  send({method:'item/started',params:{threadId:p.threadId,item:{type:'commandExecution'}}});
  send({method:'item/started',params:{threadId:p.threadId,item:{id:'commentary',type:'agentMessage',phase:'commentary'}}});
  send({method:'item/agentMessage/delta',params:{threadId:p.threadId,itemId:'commentary',delta:'thinking'}});
  send({method:'item/agentMessage/delta',params:{threadId:p.threadId,itemId:'final',delta:JSON.stringify({message:'safe',actions:[]})}});
  send({method:'item/completed',params:{threadId:p.threadId,item:{type:'agentMessage',phase:'final_answer',text:JSON.stringify({message:safe?'safe':'unsafe',actions:[]})}}});
  send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:'turn-1',status:'completed'}}});
 }
});`;
describe('native provider adapters with local protocol fixtures', () => {
  it('discovers Codex models without creating a conversation or running inference', async () => {
    const f = await fixture(codexFixture.replace("const m=JSON.parse(line);", "const m=JSON.parse(line); require('node:fs').appendFileSync('requests.jsonl',line+'\\n');"));
    const provider = new CodexProvider(f.options);
    expect(await provider.listModels(f.cwd)).toEqual({ defaultModel: 'fixture-codex', models: [{ id: 'fixture-codex', name: 'Fixture Codex', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }] });
    const methods = (await readFile(join(f.cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).method);
    expect(methods).toEqual(['initialize', 'initialized', 'config/read', 'model/list']);
    await provider.dispose();
  });
  it('sends explicit model/effort overrides and resolves defaults when clearing them on resume', async () => {
    const f = await fixture(codexFixture.replace('config:{}}', "config:{model_reasoning_effort:'ultra'}}").replace("const m=JSON.parse(line);", "const m=JSON.parse(line); require('node:fs').appendFileSync('requests.jsonl',line+'\\n');"));
    const provider = new CodexProvider(f.options);
    await provider.run(turn(f.cwd, { model: 'chosen-model', effort: 'high' }), () => {});
    await provider.run(turn(f.cwd, { model: null, effort: null, sessionId: 'session-1' }), () => {});
    const requests = (await readFile(join(f.cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'turn/start').map(request => [request.params.model, request.params.effort]))
      .toEqual([['chosen-model', 'high'], ['fixture-codex', 'medium']]);
    await provider.dispose();
  });
  it('sets the native Codex title for both new and resumed threads', async () => {
    const f = await fixture(codexFixture.replace("const m=JSON.parse(line);", "const m=JSON.parse(line); require('node:fs').appendFileSync('requests.jsonl',line+'\\n');"));
    const provider = new CodexProvider(f.options);
    const title = 'Agent duet · project · Codex · Search UI';
    await provider.run(turn(f.cwd, { title }), () => {});
    await provider.run(turn(f.cwd, { title, sessionId: 'session-1' }), () => {});
    const requests = (await readFile(join(f.cwd, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(requests.filter(request => request.method === 'thread/name/set').map(request => request.params))
      .toEqual([{ threadId: 'session-1', name: title }, { threadId: 'session-1', name: title }]);
    await provider.dispose();
  });
  it('continues a Codex turn when an older server rejects the optional title method', async () => {
    const f = await fixture(codexFixture.replace("if(m.method==='thread/name/set') send({id:m.id,result:{}});", "if(m.method==='thread/name/set') send({id:m.id,error:{code:-32601}});"));
    const provider = new CodexProvider(f.options), events: ProviderEvent[] = [];
    expect((await provider.run(turn(f.cwd, { title: 'Agent duet · example' }), event => events.push(event))).message).toBe('safe');
    expect(events).toContainEqual({ type: 'activity', text: 'Codex chat title could not be updated. Check native CLI compatibility.' });
    await provider.dispose();
  });
  it('Codex initializes v2, streams boundaries, validates reply, and resumes with per-turn policy', async () => {
    const f = await fixture(codexFixture); const provider = new CodexProvider(f.options); const events: ProviderEvent[] = [];
    expect(await provider.run(turn(f.cwd), e => events.push(e))).toEqual({ message: 'safe', actions: [] });
    expect(events).toContainEqual({ type: 'session', sessionId: 'session-1' });
    expect(events).toContainEqual({ type: 'tool_boundary' });
    expect(events).toContainEqual({ type: 'text', text: 'thinking' });
    expect(events).toContainEqual({ type: 'text', text: 'safe' });
    expect(events.filter(e => e.type === 'text').some(e => e.type === 'text' && e.text.includes('actions'))).toBe(false);
    expect(await provider.run(turn(f.cwd, { writable: true, sessionId: 'session-1' }), () => {})).toEqual({ message: 'safe', actions: [] });
    await provider.dispose();
  });
  it('Claude restricts tools and customization and uses native structured stream output', async () => {
    const f = await fixture(`
 const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1];
 let input=''; process.stdin.on('data',d=>input+=d); process.stdin.on('end',()=>{
  const settings=JSON.parse(get('--settings'));
  const safe=get('--tools')==='Read,Glob,Grep' && get('--setting-sources')==='' && settings.disableAllHooks && args.includes('--strict-mcp-config') && get('--permission-mode')==='dontAsk' && get('--model')==='claude-haiku-4-5-20251001' && get('--effort')==='low' && get('--resume')==='claude-1' && get('--name')==='Agent duet · project · Claude · Search UI';
  const send=v=>console.log(JSON.stringify(v));
  send({type:'system',subtype:'init',session_id:'claude-1',model:'claude-haiku-4-5-20251001'});
  send({type:'stream_event',event:{type:'content_block_start',content_block:{type:'tool_use',name:'Read'}}});
  send({type:'result',subtype:'success',structured_output:{message:safe&&input?'safe':'unsafe',actions:[]}});
 });`);
    const provider = new ClaudeProvider(f.options); const events: ProviderEvent[] = [];
    expect(await provider.run(turn(f.cwd, { agent: 'claude', model: 'claude-haiku-4-5-20251001', effort: 'low', sessionId: 'claude-1', title: 'Agent duet · project · Claude · Search UI' }), e => events.push(e))).toEqual({ message: 'safe', actions: [] });
    expect(events).toContainEqual({ type: 'session', sessionId: 'claude-1' });
    expect(events).toContainEqual({ type: 'activity', text: 'Claude model: claude-haiku-4-5-20251001' });
    expect(events).toContainEqual({ type: 'tool_boundary' }); await provider.dispose();
  });
  it('Claude writable tools cannot bypass Bash sandbox via file edits', async () => {
    const f = await fixture(`const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1]; const s=JSON.parse(get('--settings'));process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{message:get('--tools')==='Read,Glob,Grep,Bash'&&s.sandbox.enabled&&s.sandbox.failIfUnavailable&&!s.sandbox.allowUnsandboxedCommands?'safe':'unsafe',actions:[]}})));`);
    const provider = new ClaudeProvider(f.options);
    expect((await provider.run(turn(f.cwd, { agent: 'claude', writable: true }), () => {})).message).toBe('safe'); await provider.dispose();
  });
  it.each(['result', 'assistant'])('explains Claude OAuth refresh failures from %s diagnostics even with a success subtype', async source => {
    const diagnostic = 'Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh.';
    const messages = source === 'assistant'
      ? [{ type: 'assistant', isApiErrorMessage: true, error: 'server_error', message: { content: [{ type: 'text', text: diagnostic }] } }, { type: 'result', subtype: 'success', is_error: true, result: '' }]
      : [{ type: 'result', subtype: 'success', is_error: true, result: diagnostic }];
    const f = await fixture(`process.stdin.resume(); process.stdin.on('end', () => { for (const message of ${JSON.stringify(messages)}) console.log(JSON.stringify(message)); });`);
    const provider = new ClaudeProvider(f.options), events: ProviderEvent[] = [];
    await expect(provider.run(turn(f.cwd), event => events.push(event))).rejects.toThrow('Claude could not refresh its subscription login');
    expect(events.some(event => event.type === 'reply')).toBe(false);
    await provider.dispose();
  });
  it('does not expose arbitrary native failure output or label failures as success', async () => {
    const f = await fixture(`process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'private native diagnostic' })));`);
    const provider = new ClaudeProvider(f.options);
    await expect(provider.run(turn(f.cwd), () => {})).rejects.toThrow('Claude turn failed. Check native login');
    await provider.dispose();
  });
  it('rejects malformed model actions instead of emitting a trusted reply', async () => {
    const f = await fixture(`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',structured_output:{message:'bad',actions:[{type:'execute',command:'unsafe'}]}})));`);
    const events: ProviderEvent[] = []; const provider = new ClaudeProvider(f.options);
    await expect(provider.run(turn(f.cwd), e => events.push(e))).rejects.toThrow('invalid collaboration');
    expect(events.some(e => e.type === 'reply')).toBe(false); await provider.dispose();
  });
  it('handles missing binaries and clean protocol termination without hanging', async () => {
    const f = await fixture('process.exit(0)');
    await expect(new CodexProvider(f.options).run(turn(f.cwd), () => {})).rejects.toThrow('exited');
    await expect(new ClaudeProvider({ binary: join(f.cwd, 'missing') }).run(turn(f.cwd), () => {})).rejects.toThrow('not installed');
  });
  it('refuses external MCP tools that bypass the Codex file sandbox', async () => {
    const code = codexFixture.replace('config:{}}', 'config:{mcp_servers:{external:{enabled:true}}}}');
    const f = await fixture(code); const provider = new CodexProvider(f.options);
    await expect(provider.run(turn(f.cwd), () => {})).rejects.toThrow('cannot isolate configured Codex MCP');
    await provider.dispose();
  });
  it('refuses API authentication metadata before starting a Codex model turn', async () => {
    const f = await fixture(codexFixture.replace("account:{type:'chatgpt'}", "account:{type:'apiKey'}"));
    const provider = new CodexProvider(f.options);
    await expect(provider.run(turn(f.cwd), () => {})).rejects.toThrow('requires a ChatGPT subscription'); await provider.dispose();
  });
  it('rejects API billing environment overrides without starting providers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fake-fixture-key');
    await expect(new CodexProvider().run(turn('/tmp'), () => {})).rejects.toThrow('refuses OPENAI_API_KEY');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'fake-fixture-token');
    await expect(new ClaudeProvider().run(turn('/tmp'), () => {})).rejects.toThrow('refuses ANTHROPIC_AUTH_TOKEN');
  });
  it('aborts active native processes', async () => {
    const f = await fixture('process.stdin.resume();setInterval(()=>{},1000)'); const signal = new AbortController();
    const provider = new ClaudeProvider(f.options); const running = provider.run(turn(f.cwd, { signal: signal.signal }), () => {});
    setTimeout(() => signal.abort(), 20);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' }); await provider.dispose();
  });
  it.runIf(process.platform === 'linux')('kills native provider descendants when the harness is SIGKILLed', async () => {
    const f = await fixture(''); const ready = join(f.cwd, 'ready.json');
    await writeFile(join(f.cwd, 'native.cjs'), `
      const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});
      require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({provider:process.pid,descendant:child.pid}));
      setInterval(()=>{},1000);
    `);
    const harnessSource = `
      const {spawn}=require('node:child_process');
      spawn(process.execPath,['-e',${JSON.stringify(SUPERVISOR_SOURCE)},process.execPath,${JSON.stringify(JSON.stringify([join(f.cwd, 'native.cjs')]))}],{stdio:['ignore','ignore','ignore','ipc']});
      setInterval(()=>{},1000);
    `;
    const harness = spawn(process.execPath, ['-e', harnessSource], { stdio: 'ignore' });
    let pids: { provider: number; descendant: number } | undefined;
    const running = async (pid: number) => {
      try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z'; }
      catch { return false; }
    };
    const until = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('Timed out waiting for process supervision');
    };
    try {
      await until(async () => { try { pids = JSON.parse(await readFile(ready, 'utf8')); return Boolean(pids); } catch { return false; } });
      // Allow the supervisor to identify the child as well as its live leader.
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(await running(pids!.provider)).toBe(true); expect(await running(pids!.descendant)).toBe(true);
      harness.kill('SIGKILL');
      await until(async () => !(await running(pids!.provider)) && !(await running(pids!.descendant)));
    } finally { harness.kill('SIGKILL'); }
  }, 10_000);
});
