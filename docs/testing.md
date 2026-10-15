# Testing

## Automated checks

From the project directory, using Node.js 24 or newer:

```sh
npm ci
npm run check
```

`check` runs TypeScript checking, the production build, and Vitest. Tests do not
call real models, inspect provider logins, or consume subscription usage. Provider
tests use protocol fixtures and local subprocesses. Git tests create disposable
repositories and worktrees. Process tests exercise local supervision; their
environment must permit normal subprocess and Unix-socket execution.
Terminal lifecycle regression tests additionally use Python 3's standard-library
PTY support on Linux/macOS; they skip when that test prerequisite is unavailable.
Python is not an application runtime dependency.

Permission regressions cover default edits-enabled startup, explicit `--read-only`,
legacy saved permissions, conflicting flags, and discussion completing without
an implementation plan or integration checkpoint. Existing workspace and engine
checks verify that write access still requires an accepted plan and owned task,
and remains unavailable in read-only sessions.

| Coverage | What it establishes |
| --- | --- |
| Protocol | Exact schema validation; malformed actions and coercive values fail |
| Engine | Exact-version votes, revision handling, escalation, atomic rejection, task graph/ownership/completion gates |
| Controller | Independent initial thoughts, peer scheduling, limits, cancellation and steering, persistence, integration checkpoint, no-reply markers and empty-response loop prevention |
| Workspaces | Original checkout preservation, dirty-repository refusal, committed dependencies, finalized snapshots, conflict aborts, crash reconciliation |
| Store | Durable snapshots, private storage, session ownership, interrupted-run recovery |
| Context delivery | Incremental messages and independent state sections, private routing, mode/roster/path updates, legacy cursor migration, persisted acknowledgements, interrupted/replaced native context recovery |
| Context memory | Original file preservation, provenance, stable content updates, concrete handoffs, overlapping snapshots, input bounds and symlink rejection |
| Providers/streaming | JSON protocol handling, visible text decoding, native configuration guards, subprocess cleanup |
| Background | Local worker transport, attachment, bounded request handling |
| Terminal UI | Panes, composer and recipient controls, activity and checkpoint rendering |

Test fixtures establish behavior against the modeled native protocols. They do
not establish actual model capability, provider compatibility across releases,
or the safety of all installed native configurations.

## Offline smoke test

```sh
npm run build
node dist/cli.js --demo --headless --json --state-dir /tmp/agent-duet-smoke
npm run demo
```

The JSON snapshot should identify the scripted demo and show both agents' messages,
structured decisions, and completion. The terminal demonstration should display
streaming panes and accept keyboard controls. It never writes project files.
It does create local session state at the selected state path.

An additional offline PTY check on 2026-10-07 forced terminal colors and verified
green user text, cyan Codex text, the live-position indicator, and clean exit.

A native Codex catalog check on 2026-10-07 returned eight model choices with
their supported effort levels and the configured default. This queried metadata
only; it created no conversation or model turn. The offline PTY regression also
opens the model picker, changes model/effort, and saves without submitting a task.

For lifecycle checks, start a demo with `--detach`, attach using the printed session
id, pause/resume, detach again, and reconnect. Ordinary exit from an attached UI
should pause work; explicit `/detach` should leave the worker running. List/resume
checks should preserve the session id and history.

PTY tests launch the actual CLI entry point and verify an empty single-agent view
without a startup question. They exercise initial provider selection, a solo reply,
picker cancellation, a second instance of the same provider, named recipient cycling,
no automatic turns when a pane opens, one directed greeting reply, Ctrl+B mode
selection without submission, collaboration submitted with Enter, idle persistence
after completion, and explicit exit. UI tests cover draft preservation, persistent
selection across follow-ups, cancellation before a direct submission, independent
pane scrolling, mouse-wheel bursts, click routing in direct/collaboration modes,
resized stacked-pane hit testing, and stable history during streaming. Composer
checks cover soft wrapping, cursor visibility, unchanged submitted text, wide
characters and emoji editing. Mouse parsing tests cover split packets, ignored
releases/motion, and preserving keyboard input; PTY checks exercise real mouse
input, resizing, wrapped drafts, and terminal-mode cleanup. Copy-view checks verify
frozen output, focused-pane privacy,
full code, preserved drafts/history/routing, mouse tracking toggles, and keyboard
scrolling. PTY checks verify that a usable resume command appears after returning
to the shell. Native title fixtures cover new/resumed Codex threads, an unsupported
title method, and Claude's name argument. Transcript tests cover wide
characters, emoji, resize anchors, and access to messages beyond the previous
80,000-character display limit. Code-format tests cover inline backticks, lexical
boundaries, opaque strings/comments, and source preservation. Folding checks cover
five source lines, wrapped/blank lines, long/tilde fences, incomplete streaming
blocks, visible block selection, per-pane expansion, unchanged composer/routing,
and transferring expansion when streamed output becomes a saved reply. Controller
and model-setting tests cover per-peer persistence, changes during an active turn,
default resets, catalog effort validation, native model discovery without model
turns, and background transport. UI checks cover picker navigation, custom IDs,
cancellation, draft preservation, and explicit commands. CLI checks verify saved
effort selections on resume and independent provider overrides. Controller
tests also cover concurrent replies to both (including two Codex instances),
delivery to an idle peer during an active turn, independent completion and follow-up,
turn reservations, persisted recipient queues, steering,
and direct build completion reaching the integration checkpoint. A separate non-demo startup
test asserts zero turns and activity; native account guards prevent real provider
calls even if that test regresses. Headless execution still exits at completion.

Yield regressions cover blank and whitespace-only replies, explicit no-reply
markers, display without peer delivery, zero extra calls on idle resume/restart,
new user/peer input waking an instance, stale yielding responses after steering,
and independent work proceeding while another task remains pending. The reported
silent-loop session was traced to six accepted empty responses after three visible
replies; the harness was repeatedly scheduling turns with no new input.

## Real-provider acceptance exercise

This is separate from the automated test suite and consumes normal provider usage.
Install and sign in through both native CLIs first, then run `--doctor`. Select
`--claude-model claude-haiku-4-5-20251001` for inexpensive Claude test turns.

1. Use a small disposable project with a clean initial Git commit. Provide a design
   question in discuss scope using `/collaborate <task>` or `--collaborate`.
   Observe independent first thoughts, automatic peer
   exchanges, and a conclusion without manually forwarding messages.
2. Introduce a changed requirement using queued steering, then immediate steering.
   Confirm the next accepted response uses it. Inspect commands that already ran;
   neither steering mode should claim to roll those changes back.
3. Ask for a plan with an explicit consequential decision. Observe exact-version
   acceptances, or a user checkpoint after the initial unresolved cycle and two
   further cycles. Record undeclared disagreement or shallow consensus as quality
   findings even if the protocol mechanically succeeds.
4. Run a build with two independent tasks and a dependent task. Check per-agent
   branches, stable initial base, dependent code visibility, and preservation of
   the original checkout. Inspect each finalized diff for scope and task relevance.
5. At the integration checkpoint, run the project's actual checks in the candidate
   worktree. Submit `/accept` with the checks and outcome. Confirm acceptance records
   evidence without modifying the original branch.
6. Exercise pause, exit, resume, exhausted limits, detach/attach, and native failure.
   Confirm failed or stale turns cannot declare completion, and inspect preserved
   work rather than assuming cancellation undoes filesystem effects.

Record native CLI versions, OS, session scope, observed behavior, and limitations.
Do not publish credentials, private prompts, or raw session databases with a report.
Useful quality measures include successful delivery, retained disagreement,
stopping behavior, correction after steering, and independently verified code quality.

### Observed live smoke test — 2026-10-06

Linux, Node 24.18.0, Claude Code 2.1.291, Codex CLI 0.160.1. Native subscription
authentication was used, with Claude pinned to `claude-haiku-4-5-20251001` and
Codex using its configured default. No API credentials were supplied.

- One isolated Claude connectivity turn returned the expected structured reply.
- A real discuss session completed six combined turns in approximately 50 seconds,
  with no human message forwarding. The peers considered a CLI timer's duration
  interface, addressed each other's positions, and settled on an optional flag
  with a 25-minute default.
- The saved snapshot contained a version-1 decision with explicit acceptances
  from both peers and both finish actions. Native conversation IDs were reused
  across turns. Model selection persisted in the snapshot; the test conversation's
  native Claude transcript confirmed Haiku 4.5 was actually used.
- Four Claude turns total were used across connectivity and discussion. Discussion
  was bounded to eight combined turns and four minutes. No project edits were
  requested or performed.

This establishes real read-only communication, schema compatibility, native session
reuse, mutual acceptance, and automatic stopping for one easy agreement case.
Disagreement escalation and live steering still need evaluation beyond this easy
agreement case.

### Observed live build test — 2026-10-06

After installing `socat`, the same provider versions and pinned Haiku model ran a
bounded build in a disposable repository (14-turn/five-minute maximum). Nine turns
completed in approximately 80 seconds:

- Both peers explicitly accepted a three-task plan before obtaining write access.
- Claude wrote `greeting.txt` through sandboxed Bash; Codex independently wrote
  `farewell.txt`, each in its own Git worktree.
- Codex then received Claude's committed output through a declared dependency and
  created `combined.txt` from the actual files.
- The harness prepared a clean integration candidate and paused for validation.
  Independent checks verified all three files byte-for-byte and confirmed that
  the original `main` branch, HEAD, and project files remained unchanged.
- The test exercised integration acceptance with recorded validation evidence and
  reached `complete` without any further model calls. Native Claude created empty
  `.claude/.cc-writes` runtime directories; these did not change Git status.

This checks the functional build path, dependency visibility, native sandboxed
writes, and integration lifecycle on a tiny fixture. It does not establish sandbox
containment against arbitrary code or implementation quality on larger projects.

### Observed two-Codex discussion — 2026-10-06

`--agent codex --peer codex` completed a six-turn discussion in approximately
43 seconds. The persisted roster contained two Codex instances with two distinct
native conversation IDs. They addressed each other as Codex 1 and Codex 2 and
finished automatically. The test was read-only and bounded to six turns/three minutes.

### Observed direct greeting regression — 2026-10-06

A native session with Codex and Claude panes, without `--collaborate`, received
`hi` addressed to Codex. Codex replied “Hi! How can I help?” and returned to input
after exactly one turn. The saved snapshot contained only Codex's native session,
zero Claude activity, and an empty recipient queue. Claude was configured with
Haiku 4.5 but was never invoked. This checks the reported greeting regression;
it does not evaluate broader collaboration quality.

### Observed parallel direct chat — 2026-10-06

A read-only direct greeting addressed to two Codex instances started both native
provider calls 12 ms apart. Codex 2 completed after 4.02 seconds and Codex 1 after
4.59 seconds; each returned one greeting in its own pane. The persisted snapshot
contained two distinct native session IDs, two turns, and an empty pending queue.
The test asserted that both calls started before either completed. These timings
measure this one smoke test, not expected provider latency.

### Observed incremental-context smoke test — 2026-10-07

Codex and Claude Haiku 4.5 each received a test token in a direct message, then
correctly recalled it when a follow-up omitted the token and prior history. Both
native session IDs remained unchanged. Switching to collaboration then completed
three autonomous turns with both agents finishing. Seven native turns total ran
read-only; Claude was pinned to `claude-haiku-4-5-20251001` throughout.

Measured prompt lengths were 5,635/5,636 characters for initialization, 504 for
each direct follow-up, and 941–1,520 for collaboration turns. All five follow-up
prompts omitted the stable protocol. These measurements establish reduced
injected prompt size and retained native history for this small example; they
are not token billing or latency measurements. Native resume across a change
from the original directory to a build worktree still needs a dedicated test of
the incremental delivery path.

### Observed no-reply marker smoke test — 2026-10-07

Two native Codex instances in a read-only collaboration each returned a short
greeting and a standalone `yield` action. Both greetings remained in the visible
transcript as display-only messages. The session returned to input after exactly
two native calls, with no completion claims. Resuming without new input made zero
additional model calls. This verifies marker handling on the installed Codex CLI;
automatic empty-response fallback is covered by the offline regressions.

## Release boundaries

### Permission controls verification — 2026-10-08

`npm run check` passed all 284 tests. Coverage includes direct edits without a plan
or clean Git repository, serialized write-enabled direct recipients, permission
downgrades that stop active turns, saved-session upgrades through the CLI, attached
UI changes, directory normalization, and native provider policy arguments for
Read-only, Project, and Full access. The permission picker preserves the draft and
supports cancel without changing access. Collaboration worktree tests remain green.

A live Haiku attempt to read a temporary sibling directory and write a temporary
project file stopped at Claude's OAuth-refresh error. No successful real-provider
write validation is claimed for this change; the native protocol tests are offline.

### Agent-owned integration verification — 2026-10-08

The full check passed 294 tests, followed by a successful build and all 76 controller
tests after adding a regression for queued direct recipients in older sessions.
Coverage includes owner resolution and read-only peer review, consultation, repeated
review findings and user escalation, exact revision checks, candidate changes during
review, pause/restart recovery, and turn budgets. A real Git conflict fixture exercises
the controller, scripted agents, workspace manager, and SQLite together: conflicts are
resolved, the combined commit is reviewed, and the original checkout stays unchanged.
These are offline tests; autonomous integration quality with live models remains unverified.

Integration now assigns conflict resolution and combined validation to one agent,
then requests peer review of the exact candidate revision. The harness checks Git
state and records reported evidence; it does not independently prove semantic
correctness, test coverage, or file-to-task relevance. Independent tasks still pause
at escalated decisions. Further real-provider evaluation is needed.
Passing the offline suite does not mark that production roadmap complete.

### Per-message limits verification — 2026-10-08

`npm run check` passed all 303 tests across 19 files. Regression coverage includes
allowance resets on new input, steering before the old timer expires, paused-time
exclusion, explicit exhausted-budget resume using configured values, saved allowance
baselines, running limit changes, parallel turn reservations, slash-command parsing,
and attached UI transport validation. The PTY smoke exercises the visible per-message
turn counter. Tests use scripted providers and controlled clocks; no live model call
is needed to verify the harness-owned limits.

### Renderer memory regression — 2026-10-15

Ink 6.8.0 retained unique text indefinitely in its measurement and wrapping
caches. A local probe of 5,000 changing multiline strings grew from 19 MB to
74 MB of retained JavaScript heap despite explicit garbage collection. This is
a reproduced leak that can contribute to long-session out-of-memory crashes;
it does not establish the sole cause of the reported crash on another machine.

Upgraded to Ink 8 and its required React versions, using Ink's window-size hook
for resize handling. The renderer-cache regression processes 24,576 unique text
updates without collecting terminal frames and checks retained heap after cache
warmup. A local run stayed around 14 MB. `npm run check` passed all 306 tests in
20 files, including the memory regression, UI input and animation checks, and
real PTY CLI smoke tests. Existing installations need `npm ci` and a rebuild to
receive the dependency fix; raising Node's heap limit is not the fix.
