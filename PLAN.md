# Agent Duet implementation plan

Build a local, subscription-backed terminal workspace for two equal coding agents.
Sessions support discussion, planning, and implementation by default, with an
optional `--read-only` restriction. The user settles unresolved decisions.
No third model judges conversations. Agents explicitly propose and vote on versioned
decisions; the coordinator enforces the recorded outcome.

## Single-agent startup and optional peer

- [x] Default to edits enabled with an optional `--read-only` flag; retain saved permissions.
- [x] Allow ordinary brainstorming to finish without an implementation plan or integration checkpoint.
- [x] Start directly at an empty single-agent composer, without a startup question.
- [x] Choose the initial provider with Ctrl+G; use Ctrl+N to choose a second provider.
- [x] Separate instance identities from providers; support Codex + Codex and Claude + Claude.
- [x] Route with Tab/Shift+Tab using actual, distinct agent names and both.
- [x] Color messages by speaker and provide independent, anchored pane scrolling with a live-output shortcut.
- [x] Style inline/fenced code, preview five source lines, and expand selected visible blocks per pane.
- [x] Direct messages schedule only their recipients; opening a pane starts no work.
- [x] Run independent direct requests concurrently, including two instances of one provider.
- [x] Select collaboration with Ctrl+B without submitting; Enter sends in that mode, including follow-ups.
- [x] Persist rosters and keep native sessions, votes, tasks and worktrees per instance.
- [x] Exercise independent same-provider conversations with a bounded live test.

## Persistent context and incremental delivery

- [x] Store stable protocol and session projections in a private `.agent/` directory.
- [x] Read existing project memory with provenance without rewriting project entry points.
- [x] Persist per-instance delivery checkpoints; send new messages and changed state on normal turns.
- [x] Replay accepted context on interruption or native-ID replacement; retain all harness history.
- [x] Keep native conversation history; do not compact each turn or create no-op handoffs.
- [x] Verify native recall and collaboration with Codex and Claude Haiku.
- [x] Add explicit no-reply markers and stop empty-response loops without declaring unfinished work complete.

## Sequence

1. **Foundation and protocol** — TypeScript, shared provider interface, versioned
   decision state machine, deterministic demo, SQLite persistence, meaningful tests.
2. **Terminal workspace** — split streaming panes, multiline composer, recipient and
   steering controls, expandable activity, decision cards, pause/resume.
3. **Native integrations** — Codex app-server and unmodified Claude Code streaming
   CLI. Native tools own subscription authentication; never copy or broker tokens.
   Detect missing binaries and incompatible capabilities explicitly.
4. **Orchestration** — independent initial proposals, automatic peer delivery,
   explicit plan acceptance, two unresolved resolution rounds then user escalation,
   bounded execution, durable session history and interrupted-run recovery.
5. **Build execution** — separate worktrees for independent tasks, dependency-aware
   scheduling and explicit integration checkpoints. Project writes must remain
   disabled before mutual acceptance. Do not pretend prompt instructions enforce
   filesystem restrictions.
6. **Validation and release preparation** — unit and integration tests, offline
   end-to-end demo, terminal smoke test, provider protocol fixtures, documentation,
   MIT license and provenance. Real provider testing is reported separately from
   deterministic demonstrations.

## Acceptance checks

- An explicit collaboration brief triggers both agents and several exchanges without manual forwarding.
- Acceptances refer to an exact proposal version; stale votes cannot unlock edits.
- Missing answers and requests for evidence are not agreement.
- Two unresolved resolution rounds create a user decision checkpoint.
- Pause, limits, restart, failure, and stale asynchronous results cannot silently
  continue work or overwrite newer user instructions.
- Ordinary exit pauses; explicit background execution must be clearly identified.
- Existing user repository changes are preserved.

## Implementation choices

Node.js 24+, TypeScript, Ink/React for the terminal, built-in SQLite for local state.
Provider adapters emit normalized events. A deterministic coordinator schedules
turns. Agent responses include a validated structured collaboration envelope.
Natural-language agreement alone never changes permissions.

## Progress

- [x] Design confirmed; dedicated project directory created.
- [x] Foundation, decision engine, and persistence.
- [x] Terminal workspace and offline demo.
- [x] Native provider adapters and orchestration (protocol fixtures and live discuss smoke test).
- [x] Isolated build workspaces and integration workflow with manual combined validation.
- [x] Tests, review, and usage documentation.

## Initial implementation boundaries and next evaluation

- Validation: `npm run check` passes TypeScript checking, production compilation,
  and 266 offline tests, including per-peer model/effort selection, copy mode, native chat titles, exit resume commands, mouse controls, wrapped drafts, code formatting/folding, no-reply markers, idle scheduling, incremental context, recovery checkpoints,
  project memory, independent anchored scrolling, Unicode wrapping,
  collaboration mode selection without submission,
  default/read-only permissions, empty startup, agent picker, same-provider
  instance isolation, addressed-only chat, explicit collaboration, named routing,
  and terminal lifecycle regressions. A live directed greeting produced one Codex
  reply and zero Claude calls. A live two-Codex direct broadcast verified overlapping
  native calls and two distinct sessions, returning one greeting each in 4.6 seconds.
  The real terminal demo and detached-worker lifecycle were
  also exercised. A real subscription-backed discussion completed six autonomous
  turns with both agents accepting the same decision and finishing.
- The offline demo completes seven autonomous turns and persists mutual agreement.
  It is a scripted fixture, not evidence of real-model collaboration quality.
- Live testing used Claude Code 2.1.291 with Haiku 4.5 explicitly selected and
  Codex CLI 0.160.1. Persisted provider sessions and model choice were verified.
  With `socat` installed, a nine-turn build exercised sandboxed Claude writes,
  independent tasks, dependency integration, and a verified combined candidate.
  The broader acceptance exercise remains open. See `docs/testing.md` for evidence
  and limits of these bounded tests.
- Combined build validation is an explicit user checkpoint (`/accept` with evidence).
  Automated combined validation is a later milestone.
- Escalated decisions currently pause the whole session. Continuing unrelated work
  through a decision checkpoint needs a decision-to-task dependency model.
- Native runtime permissions are enforced before writes, and native processes have
  parent-liveness supervision. Neither those mechanisms nor a passing test suite
  prove semantic correctness, task relevance, or general containment of arbitrary
  daemonizing code.
- Further real-provider tests should assess whether structured decision checkpoints
  preserve useful disagreements, including after steering and resume.
