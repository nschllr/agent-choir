# Agent Duet

A local terminal workspace that starts with one agent and adds a second when you
want a peer. Choose Codex or Claude for each pane, including two instances of the
same provider. Agents brainstorm, make explicit decisions, and work on the same
project as equal peers. Discuss, plan, and implement in one session; use `--read-only`
when you want to prevent edits. You settle unresolved decisions. The coordinator is ordinary software, not a third
model judging their conversation.

This is an initial implementation for Linux. Real Claude/Codex smoke tests have
completed an autonomous discussion and a small build with shared task dependencies.
The offline demonstration and automated tests use scripted providers. See
[testing evidence and remaining checks](docs/testing.md) for the limits of these tests.

## Try the offline demonstration

Requires Node.js 24 or newer and npm. From the checked-out project directory:

```sh
npm ci
npm run build
npm run demo
```

The demonstration shows two panes, automatic discussion, and structured agreement.
It uses deterministic scripts, makes no model calls, consumes no subscriptions,
and never edits the selected project. A narrow terminal stacks the panes.
Use `npm run dev -- --demo --agent codex` for an empty interactive demo where you
can try chatting, adding a peer, and selecting message recipients without model calls.

To see its final state without a terminal UI:

```sh
node dist/cli.js --demo --headless --json
```

There is no published npm package yet. Invoke `node dist/cli.js` after building,
or use `npm run dev --` during development. Examples using `agent-duet` in the
built-in help assume you have made that executable available yourself.

## Connect your own native agents

Install Git and both native CLIs using the providers' instructions:
[Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and
[Claude Code setup](https://code.claude.com/docs/en/setup). Sign in through their
own interfaces using your existing eligible accounts:

```sh
codex login
claude
node dist/cli.js --doctor
```

Install each provider you intend to use on `PATH`. Agent Duet starts the unmodified native
programs and resumes their native sessions. It does not offer its own login,
extract tokens, broker credentials, or make direct model API requests. The native
CLI owns the active account. Before starting model work, Agent Duet checks native
authentication metadata for a ChatGPT/Claude subscription login and rejects known
API-key or alternate-inference environment overrides. Incompatible or missing
metadata fails explicitly; it never silently falls back to API billing. These
account checks have been exercised with the installed native CLIs.
Live work consumes normal provider usage and remains subject to account eligibility
and provider limits.

Linux is the supported initial platform. Claude build turns require working
native Bash sandbox support, including `bwrap` and `socat`; follow the
[Claude sandbox setup](https://code.claude.com/docs/en/sandboxing). Missing or
incompatible sandbox support fails the turn instead of allowing an unsandboxed
fallback. `--doctor` checks binaries without inspecting credentials or calling models.

External native tools can escape an ordinary shell sandbox. Agent Duet therefore
disables Claude hooks/MCP and limits its tools; read-only Claude turns have no Bash,
Edit, or Write tools. Build writes use sandboxed Bash. Codex uses read-only or
workspace-write policy and disables ancillary tools. Its adapter refuses an
effective configuration containing enabled MCP servers or configured hooks.

For an isolation error, use a dedicated project/native configuration without
those integrations and check the effective native configuration for that project.
Keep unrelated global workflows intact. Configuration overrides must also apply
to generated worktree paths, since build turns run there. Agent Duet does not
rewrite your native configuration. CLI incompatibilities or interactive approval
requests produce an explicit error; they are not silently approved.

## Start a session

`npm run dev` opens directly into an empty Codex chat; no startup question or model
request runs before your first message. Press **Ctrl+G** to choose Claude instead
before chatting. A solo agent answers you and returns to the composer.

The default session supports discussion, planning, and implementation. Edits become
available only after an accepted plan assigns a ready task to the agent; starting
the app does not request implementation. Use `--read-only` to enforce inspection
and conversation without project edits. The header shows **edits enabled** or
**read-only**. Brainstorming can finish without creating an implementation plan.

Press **Ctrl+N** when you want a peer. The new pane lets you choose **Codex** or
**Claude** with the arrow keys and Enter; Esc cancels. Adding a pane leaves both
agents idle until you send a message. Two Codex instances display
as **Codex 1** and **Codex 2**, with separate
native conversations and worktrees. **Tab / Shift+Tab** changes the composer target
between the actual agent names and **both**. A directed message gets one response
from that instance; **both** starts both agents in parallel, with one response
from each. You can also message an idle agent while the other is working, and
continue with whichever answers first. Replies do not wake the other agent.
For example, sending “hi” to Codex leaves Claude idle.

Press **Ctrl+B** to toggle collaboration mode, then write a task and press **Enter**.
The toggle preserves any draft and never submits it. The composer shows
**collaboration ON** and both agent names. Enter shares the conversation history
and starts bounded autonomous exchanges; subsequent messages stay in collaboration
mode until you switch it off. Ctrl+B again restores direct chat and pauses an
active collaboration. In direct chat, Tab selects one agent or both independently.

`/collaborate` also enables the mode, and `/chat` disables it. For a one-command
start, `/collaborate <task>` enables collaboration and submits that task.
Project decisions and tasks remain shared state; their approval requirements
still apply in direct chat.

Agents can return a structured `yield` action when no peer reply is needed.
The message remains visible in the panes but is not forwarded to the other model.
An empty response with no actions also yields. A yielded agent runs again only
when new user/peer input or relevant shared state arrives. Independent ready tasks
can continue. When there is no further input or ready work, the harness returns to
the composer with a visible notice; yielding does not complete pending tasks.
Resuming an idle session alone does not start another empty exchange. Explicitly
submitting a new collaboration request shares the displayed history, including
earlier no-reply messages, as context for that request.

```sh
npm run dev
npm run dev -- --read-only
npm run dev -- --agent claude --claude-model claude-haiku-4-5-20251001

npm run dev -- --project /absolute/path/to/project --peer claude --collaborate \
  "Explore three approaches to offline synchronization and preserve disagreements."

node dist/cli.js --project /absolute/path/to/project --agent codex --peer codex --collaborate \
  "Design user search with acceptance criteria and independent implementation tasks."

node dist/cli.js --project /absolute/path/to/project --peer claude --collaborate \
  "Implement user search and verify the result against the existing tests."
```

Implementation requires every active agent to explicitly accept the same plan
version. In explicit collaboration, two agents starting
together give independent initial thoughts, then exchange messages automatically.
Ready tasks owned by different agents can run in parallel.
Without `--collaborate`, a command-line brief goes only to the first agent.

Saved sessions retain their original permissions when resumed. Legacy `--scope
discuss|plan|build` arguments are still accepted for existing scripts; new sessions
normally need no scope flag. A legacy `plan` session retains its agreed-plan
completion requirement. `--read-only` cannot be combined with `--scope build`.

Select models with `--claude-model haiku` and `--codex-model MODEL_ID`. Without
an override, each native agent uses its configured default. Selections are saved
with the session and reused on resume and detach; `--resume` can override either
selection while preserving the other. `--attach` uses the running worker's models.
Provider model preferences also apply to an agent added later with the picker.
The offline demo accepts these options for testing persistence but makes no calls.
For the inexpensive model used in the live smoke test, pin
`--claude-model claude-haiku-4-5-20251001`. The six-turn real discussion completed
automatically; see [observed results and remaining checks](docs/testing.md#observed-live-smoke-test--2026-10-06).

Build preparation requires a clean Git repository root with an existing HEAD.
Preserve your current work by committing or stashing it yourself before starting.
Agent instances get separate worktrees and branches; Agent Duet does not edit,
checkout, or commit on your original branch. Worktrees remain available afterward.

## Terminal controls

After both agents finish, the interactive view stays open. Send a follow-up to
continue the conversation, or use `/quit` or Ctrl+C to exit. Messages entered while
explicitly paused remain queued until you resume. When output is redirected or no terminal
is available, the CLI announces headless mode and exits at completion instead.

| Control | Action |
| --- | --- |
| Enter | Send the composer text |
| Alt+Enter or Ctrl+J | Insert a newline |
| Ctrl+G | Choose the initial agent before the first message |
| Ctrl+N | Open the second pane's agent picker |
| Ctrl+B | Toggle collaboration mode without submitting or clearing the draft (requires two agents) |
| Tab / Shift+Tab | Cycle actual agent names and both |
| Ctrl+S | Toggle queued versus immediate steering |
| Ctrl+P | Pause or resume |
| Ctrl+O | Show or hide recent tool activity |
| Ctrl+F | Switch the pane being scrolled; the message recipient stays unchanged |
| Ctrl+X | Expand or collapse the selected visible code block in the focused pane |
| Ctrl+K | Select the next expandable code block currently visible in that pane |
| PgUp / PgDn | Scroll the focused pane by a page |
| Alt+↑ / Alt+↓ | Scroll the focused pane by one line |
| Home / End | Jump to the oldest messages / return to live output |
| Left / Right, Ctrl+A / Ctrl+E | Move the composer cursor |
| Ctrl+U | Clear the composer |
| Ctrl+C | Pause and exit |

Some terminals reserve Ctrl+S for flow control; `/steer immediate` and
`/steer queued` provide the same setting without that shortcut.

Your messages are green and session notices are yellow. Each pane highlights its
own agent's replies in cyan or magenta, with peer replies in muted gray. Speaker names
remain visible when terminal colors are disabled. A double border and arrow mark
the pane selected for scrolling; each pane retains its own position. While you
read history, new output does not move the view. End resumes following the latest
output. The pane footer shows its history position or the controls for visible code.

Fenced code blocks have a language label, an indented border, and a five-source-line
preview. Longer lines wrap to fit the pane. Ctrl+X expands the selected visible
block, and Ctrl+K cycles between visible long blocks; Ctrl+F chooses the pane.
The selected block has an arrow in its header. Expansion anchors the view to that
block so new output does not pull you away; End returns to live output. Each pane
keeps its own expanded blocks while you scroll. Folding changes only presentation,
never the stored message or the context sent to agents.

Inline backtick code is highlighted. Common fenced languages receive basic
syntax colors for keywords, strings, numbers, and comments; unrecognized languages
retain plain code formatting. Peer code remains muted gray, with structure and
keyword emphasis. Backtick and tilde fences are supported, including unfinished
blocks while a reply streams. Highlighting is lexical, not a full language parser.

Commands: `/help`, `/split [codex|claude]`, `/agent [codex|claude]`, `/pause`, `/resume`, `/to <agent name>|both`,
`/collaborate [task]`, `/chat`, `/steer queued|immediate`, `/resolve ID resolution`, `/accept validation evidence`,
`/detach`, and `/quit`.

The composer displays its current recipient; `/to Codex 2` also selects a numbered
instance. Queued steering interrupts at a reported tool
boundary, or discards a completed response if no boundary arrives. Immediate
steering cancels the ongoing turn and delivers the changed instruction on a new
turn. Neither mode rolls back commands already executed. Messages sent while
paused are saved; use `/resume` to continue.

## Decisions and completion

Agents explicitly propose, accept, object, or request evidence. Natural-language
agreement does not unlock edits. All current instances' acceptances must reference the exact current
version. Revisions clear votes, and preserve unresolved-round counts. An initial
unresolved voting cycle followed by two unsuccessful resolution cycles becomes
`waiting_user`; use `/resolve ID your choice`, then `/resume`. An ordinary decision
records your final choice. Resolving a plan clears its obsolete task graph: the
agents must propose a concrete replacement honoring your choice and all accept
the new version before implementation can begin.

Missing votes remain pending rather than becoming agreement. Turn/time limits
checkpoint conversations that stall. In this release, an escalated decision
pauses the whole session; letting unrelated tasks continue through a decision
checkpoint is future work. Changing a saved session's permissions requires a new session.
Adding a peer reopens prior agent agreements for the enlarged roster while retaining
user decisions. Validate an outstanding build integration candidate before adding
a peer. A peer joining an already validated build triggers fresh agreement and
validation before that expanded session can declare completion.

Each writable turn receives one active task owned by that agent. The coordinator
rejects completion of a sibling task on that turn. It commits the current owned
worktree snapshot after task completion; it cannot prove that every changed file
semantically belongs to that task. Review the resulting diff.

Build completion includes a **manual combined-validation checkpoint**. Finalized
agent commits are merged into a separate integration worktree. Inspect its diff,
run the project's relevant checks there, then record the actual evidence:

```text
/accept Ran the project test suite in the integration worktree; all tests passed.
```

`/accept` records your evidence and completes the session. It does not run a
validator or merge into your original branch. Choose how to adopt the candidate
through your normal Git workflow. If integration conflicts, the attempted merge
is aborted and all work is preserved. Resolve and commit the merge manually in
the integration worktree, then `/resume` retries integration. Once the candidate
is conflict-free, validate it and `/accept`.

## Persistence, limits, and background work

```sh
node dist/cli.js --list
node dist/cli.js --resume SESSION_ID
node dist/cli.js --resume SESSION_ID --headless --json
node dist/cli.js --detach --project /absolute/path/to/project --read-only \
  "Explore alternatives and produce a recommendation."
node dist/cli.js --attach SESSION_ID
```

Ordinary exit pauses. Interactive `--resume` restores a paused view; use `/resume`
or Ctrl+P to run it. Headless resume explicitly starts work. `/detach` or `--detach`
starts intentional background execution; `--attach` reconnects. An attached UI's
ordinary exit pauses the worker, while `/detach` disconnects and leaves it running.
The worker stays available at completion/checkpoints until its process is
terminated; exiting the attached UI only pauses it. While that worker owns the
session, reconnect with `--attach` rather than opening it with `--resume`.
There is no dedicated worker-stop command in this release.

Default allowances are 30 provider turns and 30 minutes of active wall time.
Set `--max-turns N` and `--max-minutes N`. Explicit resume of an exhausted allowance
adds 30 turns or 30 minutes; limits are never renewed automatically. These are
scheduling limits, not exact token or monetary budgets.

State lives in `$XDG_STATE_HOME/agent-duet`, or
`~/.local/state/agent-duet` when XDG_STATE_HOME is unset. Override with
`--state-dir /absolute/path`. It contains private SQLite session snapshots,
ownership locks, worktree metadata, background sockets, and worker logs. Keep it
outside the project repository and exclude it from publication. Private filesystem
permissions restrict local access; state is not encrypted. Native providers keep
their own additional session history according to their configuration.

A session has one process owner. Interrupted saved sessions recover paused.
Native subprocess supervision cancels processes when the owning harness exits;
this is not a general container or a guarantee that arbitrary daemonizing code
cannot survive. See [architecture](docs/architecture.md) for the boundaries.

## Shared context and project memory

Each agent keeps its native conversation. Stable harness instructions are loaded
at initialization or recovery; normal turns contain new messages and changed shared
state. Filesystem access is enforced through native runtime policies rather than
a repeated prompt footer. Switching between chat and collaboration
sends explicit mode instructions. Mode/scope and the context directory are sent
at initialization/recovery or when they change. Decisions, task completions, and
peer completion summaries are tracked independently, so a new peer summary does
not resend unchanged empty task lists. The harness does **not compact conversations
each turn** or resend the transcript on every exchange.

Agent Duet maintains a private context directory at
`STATE_DIR/context/SESSION_ID/.agent/` containing `INSTRUCTIONS.md`,
`environment.md`, `shared-state.md`, `decisions.md`, and `task-board.md`.
`handoff.md` appears when there are completed tasks or a decision/integration
checkpoint. These are readable projections of session state; SQLite remains the
authority for permissions, votes, and ownership. Unchanged files are not rewritten.

Existing project `.agent/` files are also supported: `INSTRUCTIONS.md`,
`PROJECT-INSTRUCTIONS.md`, `environment.md`, `shared-state.md`, `decisions.md`,
`task-board.md`, and `handoff.md`. Their content is supplied with provenance, then
only changed files are supplied again. They are project context, not permission
overrides. Inputs are limited to 64 KiB per file and 256 KiB total; oversized or
symlinked inputs produce an explicit error. Project memory is read from the
original project directory, so worktree changes become shared input only when
adopted there through the normal project workflow.

The harness leaves project `AGENTS.md`, `CLAUDE.md`, and `.agent/` files unchanged.
It does not automatically summarize chats into project memory. Delivery checkpoints
survive pause/resume. After an interrupted turn, context may be replayed with the
same message IDs to avoid losing input. If a native conversation has been deleted
or cannot be resumed, the adapter reports the failure; automatic replacement of
an unavailable native conversation is not implemented.

## Development and provenance

```sh
npm run check
```

This typechecks, builds, and runs offline unit/integration tests. See
[testing](docs/testing.md) for coverage, an offline smoke test, and the separate
real-provider acceptance exercise.

Original Agent Duet source is MIT licensed. No source from another harness was
copied.
The `.agent/` layout and separation of durable facts, environment knowledge,
decisions, tasks, and handoffs were informed by
[shared-agent-memory](https://github.com/nschllr/shared-agent-memory).
No source or instruction text was copied from that repository.
Dependencies retain their own licenses.
