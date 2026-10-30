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
| Workspaces | Original checkout preservation, dirty-repository refusal, committed dependencies, finalized snapshots, repeated completions, conflict aborts, crash reconciliation, adoption into a clean or changed checkout, cleanup of branches/worktrees/refs |
| Store | Durable snapshots, private storage, session ownership, interrupted-run recovery |
| Context delivery | Incremental messages and independent state sections, private routing, mode/roster/path updates, legacy cursor migration, persisted acknowledgements, interrupted/replaced native context recovery |
| Context memory | Original file preservation, provenance, stable content updates, concrete handoffs, overlapping snapshots, input bounds and symlink rejection |
| Providers/streaming | JSON protocol handling, visible text decoding, native configuration guards, opt-in stderr diagnostics, subprocess cleanup |
| Background | Local worker transport, attachment, bounded request handling |
| Terminal UI | Panes, composer and recipient controls, activity and checkpoint rendering |

Test fixtures establish behavior against the modeled native protocols. They do
not establish actual model capability, provider compatibility across releases,
or the safety of all installed native configurations.

## Offline smoke test

```sh
npm run build
node dist/cli.js --demo --headless --json --state-dir /tmp/agent-choir-smoke
npm run demo
```

The JSON snapshot should identify the scripted demo and show both agents' messages,
structured decisions, and completion. The terminal demonstration should display
streaming panes and accept keyboard controls. It never writes project files.
It does create local session state at the selected state path.

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
