import type { AgentId, AgentProvider, AgentReply, ProviderEvent, ProviderTurn } from './types.js';

/** An explicitly labelled offline fixture. It never contacts a model or edits files. */
export class DemoProvider implements AgentProvider {
  constructor(readonly id: AgentId, private delayMs = 18) {}
  async run(turn: ProviderTurn, emit: (event: ProviderEvent) => void): Promise<AgentReply> {
    const step = Number(turn.sessionId?.split(':').at(-1) ?? 0);
    const reply: AgentReply = turn.prompt.includes('Mode: chat.')
      ? { message: 'Hello! What would you like to work on? [Offline simulation]', actions: [] }
      : this.id === 'claude' || this.id === 'codex' ? this.reply(step) : this.interactiveReply(turn);
    emit({ type: 'activity', text: 'Offline simulation · no model or shell calls' });
    for (const word of reply.message.split(/(?<=\s)/)) {
      if (turn.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      await new Promise<void>(resolve => setTimeout(resolve, this.delayMs));
      emit({ type: 'text', text: word });
    }
    emit({ type: 'tool_boundary' });
    if (turn.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    emit({ type: 'session', sessionId: `demo:${this.id}:${step + 1}` });
    return reply;
  }
  private interactiveReply(turn: ProviderTurn): AgentReply {
    if (turn.prompt.includes('INITIAL INDEPENDENT EXPLORATION')) return { message: 'My initial thought: make the workflow easy to inspect and keep decisions explicit. [Offline simulation]', actions: [] };
    if (turn.prompt.includes('Scope: discuss.')) return { message: 'I have considered the shared conversation. Keep the workflow simple, and add a peer when a second perspective helps. Send another message to continue. [Offline simulation]', actions: [{ type: 'finish', summary: 'Offline reply complete; no model calls or edits.' }] };
    const decisions = JSON.parse(turn.prompt.match(/^Current decisions and tasks \(data\): (.*)$/m)?.[1] ?? '[]');
    const plan = decisions.find((decision: any) => decision.kind === 'plan');
    if (!plan) return { message: 'I propose a small, explicit plan with no implementation tasks in this simulation.', actions: [
      { type: 'propose', id: 'plan', kind: 'plan', title: 'Offline example', proposal: 'Keep agent instances independent and make decisions explicit.', tasks: [] },
      { type: 'position', id: 'plan', version: 1, position: 'accept', reason: 'This is a bounded offline example.' },
    ] };
    if (plan.status === 'open' && !plan.positions[turn.agent]) return { message: 'I accept the current plan.', actions: [{ type: 'position', id: plan.id, version: plan.version, position: 'accept', reason: 'The proposed scope is clear.' }] };
    return { message: 'The offline plan is agreed. You can continue with a follow-up.', actions: [{ type: 'finish', summary: 'Offline plan completed.' }] };
  }
  private reply(step: number): AgentReply {
    if (step === 0) return { message: this.id === 'claude'
      ? 'I would start with local SQLite persistence and a versioned decision protocol. What happens when an agent accepts an outdated plan?'
      : 'My independent proposal is an append-only discussion history with explicit plan versions. We should test restart recovery and stale votes before adding parallel edits.', actions: [] };
    if (this.id === 'claude' && step === 1) return { message: 'Let’s combine those approaches: SQLite snapshots, explicit votes tied to a version, and recovery that pauses rather than restarting work.', actions: [{ type: 'propose', id: 'plan', kind: 'plan', title: 'A local collaboration protocol', proposal: 'Use SQLite persistence, versioned plan acceptance, and explicit pause/resume. Test stale votes and interrupted sessions before implementation.', tasks: [] }] };
    if (this.id === 'codex' && step === 1) return { message: 'Agreed. Clearing votes on revision addresses my concern. Recovery must retain the transcript while leaving both agents paused.', actions: [{ type: 'position', id: 'plan', version: 1, position: 'accept', reason: 'Version checks and paused recovery cover the main failure modes.' }] };
    if (this.id === 'claude' && step === 2) return { message: 'I accept this version too. The useful guarantee is explicit acceptance, not an assumption that the agents agree semantically.', actions: [{ type: 'position', id: 'plan', version: 1, position: 'accept', reason: 'This is bounded, local, and testable.' }] };
    return { message: this.id === 'codex' ? 'Conclusion: start with the decision protocol and persistence. Keep semantic disagreement visible and leave unresolved choices to the user.' : 'We have an agreed plan and explicit tests for it. This demonstration is complete; no project files were edited.', actions: [{ type: 'finish', summary: 'Agreed on versioned decisions, SQLite persistence, and paused recovery. This was a deterministic offline demonstration.' }] };
  }
  async dispose(): Promise<void> {}
}
