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

Linux is the supported initial platform. Claude Project-mode write turns require working
native Bash sandbox support, including `bwrap` and `socat`; follow the
[Claude sandbox setup](https://code.claude.com/docs/en/sandboxing). Missing or
incompatible sandbox support fails the turn instead of allowing an unsandboxed
fallback. `--doctor` checks binaries without inspecting credentials or calling models.

External native tools can escape an ordinary shell sandbox. Agent Duet therefore
disables Claude hooks/MCP and limits its tools; read-only Claude turns have no Bash,
Edit, or Write tools. Project-mode writes use sandboxed Bash. Full access enables
Claude Bash/Edit/Write without the filesystem/network sandbox. Codex uses the
selected read-only, workspace-write, or full-access policy and disables ancillary tools. Its adapter refuses an
effective configuration containing enabled MCP servers or configured hooks.

For an isolation error, use a dedicated project/native configuration without
those integrations and check the effective native configuration for that project.
Keep unrelated global workflows intact. Configuration overrides must also apply
to generated worktree paths, since collaboration implementation runs there. Agent Duet does not
rewrite your native configuration. CLI incompatibilities or interactive approval
requests produce an explicit error; they are not silently approved.

## Start a session

`npm run dev` opens directly into an empty Codex chat; no startup question or model
request runs before your first message. Press **Ctrl+G** to choose Claude instead
before chatting. A solo agent answers you and returns to the composer.

The default session permits direct project editing when you request it, with no
plan vote or task assignment. Discussion and brainstorming still need no edits.
Use `--read-only` to prevent edits, or change permissions during the session with
**Ctrl+L**. The header shows **project edits**, **read-only**, or **full access**.
Collaboration implementation continues to require an agreed plan and assigned tasks.

Press **Ctrl+N** when you want a peer. The new pane lets you choose **Codex** or
**Claude** with the arrow keys and Enter; Esc cancels. Adding a pane leaves both
agents idle until you send a message. Two Codex instances display
as **Codex 1** and **Codex 2**, with separate
native conversations and worktrees. **Tab / Shift+Tab** changes the composer target
between the actual agent names and **both**. A directed message gets one response
from that instance; **both** requests one response from each. Read-only turns run
in parallel. Write-enabled direct turns run one at a time because they edit the
same project folder; messages to the second agent remain queued until its turn. Replies do not wake the other agent.
For example, sending “hi” to Codex leaves Claude idle.

Press **Ctrl+B** to toggle collaboration mode, then write a task and press **Enter**.
The toggle preserves any draft and never submits it. The composer shows
**collaboration ON** and both agent names. Enter shares the conversation history
and starts bounded autonomous exchanges; subsequent messages stay in collaboration
mode until you switch it off. Ctrl+B again restores direct chat and pauses an
active collaboration. In direct chat, Tab selects one agent or both independently.

`/collaborate` also enables the mode, and `/chat` disables it. For a one-command
start, `/collaborate <task>` enables collaboration and submits that task.
Direct chat edits the original project folder and uses ordinary replies. Formal
plan votes, task completion, isolated worktrees, and integration belong to collaboration.
Existing collaboration worktrees are retained when you switch modes.

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

Collaborative implementation requires every active agent to explicitly accept the same plan
version. In explicit collaboration, two agents starting
together give independent initial thoughts, then exchange messages automatically.
Ready tasks owned by different agents can run in parallel in Project mode without shared extra directories.
Without `--collaborate`, a command-line brief goes only to the first agent.

Saved sessions retain their selected permissions unless you change them with
`--permissions MODE` on resume or Ctrl+L in the TUI. Legacy `--scope
discuss|plan|build` arguments are still accepted for existing scripts; new sessions
normally need no scope flag. A legacy `plan` session retains its agreed-plan
completion requirement. `--read-only` cannot be combined with `--scope build`.

Select models with `--claude-model haiku` and `--codex-model MODEL_ID`. Without
an override, each native agent uses its configured default. Selections are saved
with the session and reused on resume and detach; `--resume` can override either
selection while preserving the other. `--attach` uses the running worker's models.
Provider model preferences also apply to an agent added later with the picker.
The offline demo accepts these options for testing persistence but makes no calls.

Press **Ctrl+R** or enter `/model` to configure the focused pane's model and
reasoning effort. Use **Up/Down** to select a model, **Left/Right** to choose effort,
and **Enter** to save; **Esc** cancels. Select **Custom model ID** to enter a specific
version. Your draft and message recipient stay unchanged. Ctrl+F changes the focused
pane before opening the selector; each peer has independent settings, including
two peers using the same provider.

Changes apply on the next native turn, preserve conversation history, and persist
through resume, detach, and attach. Running turns finish with their original
settings. Each pane shows the requested model/effort; the native CLI may enforce
account or organization limits. Choosing **Native default** clears the harness
override. Changing models resets the effort choice so an incompatible level is not
carried over.

Codex choices and supported efforts come from the native
[`model/list` catalog](https://learn.chatgpt.com/docs/app-server#list-models-modellist).
Opening the picker queries metadata without creating a conversation or consuming
a model turn. Claude choices use native aliases and the CLI's effort levels;
[availability and effort limits](https://code.claude.com/docs/en/model-config)
depend on the native installation and account. If discovery fails, custom IDs and
native defaults remain available. An unknown custom Codex model may require an
explicit effort if its default cannot be resolved from the native catalog.

Commands also target the focused pane: `/model MODEL_ID`, `/model default`,
`/effort LEVEL`, and `/effort default`. The startup flags `--claude-effort LEVEL`
and `--codex-effort LEVEL` set saved defaults for instances of that provider;
`default` clears an effort override. For example:

```sh
agent-duet --agent codex --codex-model MODEL_ID --codex-effort high
```

For the inexpensive model used in the live smoke test, pin
`--claude-model claude-haiku-4-5-20251001`. The six-turn real discussion completed
automatically; see [observed results and remaining checks](docs/testing.md#observed-live-smoke-test--2026-10-06).

Direct editing works in ordinary folders and dirty repositories and writes to the
original project; the harness does not auto-commit these edits. Collaborative build
preparation requires a clean Git repository root with an existing HEAD. Collaboration
uses separate worktrees and branches, retained afterward, and an integration candidate
for review. Turns with Full access or shared additional directories are serialized
during collaborative implementation because they can reach shared files.

## Permission controls

Press **Ctrl+L** or enter `/permissions` to choose session-wide permissions for both peers:

| Mode | Access |
| --- | --- |
| Read-only | File inspection; project edits disabled. Claude has no shell tool. |
| Project (default) | Write in the active project/worktree and explicitly added directories; shell network access disabled. |
| Full access | Filesystem and shell network access as your user, without the filesystem/network sandbox. |

In the selector, ↑/↓ changes mode, **A** adds a directory, **D** removes the last
one, Enter saves, and Esc cancels. Additional directories permit native file reads
and, in Project mode, writes. Relative paths resolve against the original project,
not a generated worktree. These are write boundaries, not a promise that other
local files are unreadable; native read policies may allow broader inspection.

Commands are also available:

```text
/permissions project
/permissions full
/permissions read-only
/permissions add ../shared
/permissions remove /absolute/path/to/shared
```

For removal, use the absolute path shown in the selector. Paths may contain spaces;
use them as-is without shell quotes in slash commands. Saving stops active native
turns before applying the new permissions and leaves their work queued. Press
Ctrl+P to resume pending work; an idle chat accepts your next message normally.
Settings persist through restart and background attachment. Full access is explicit,
never the default; it does not enable additional hooks, MCP servers, or native subagents.

```sh
agent-duet --resume SESSION_ID --permissions project
agent-duet --permissions full
agent-duet --allow-dir ../shared
```

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
| Ctrl+R | Select model and reasoning effort for the focused pane |
| Ctrl+Y or /copy | Open a frozen, single-column copy view of the focused pane; Esc/Ctrl+Y returns |
| Mouse wheel | Scroll the pane under the pointer, without changing the recipient |
| Ctrl+L | Change session permissions and additional directories |
| Click a pane | Focus it and select its agent for direct messages; collaboration still sends to both |
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

While an agent works, its pane shows a spinner in the agent's color below the
conversation, with elapsed time and the latest activity. Each pane updates
independently. Animation stops in copy mode and while a settings view is open.

Long drafts wrap automatically. The composer grows to four display lines, then
scrolls to keep the cursor visible. Soft wrapping does not insert newlines into
the message; Alt+Enter or Ctrl+J inserts an actual newline. Left/Right and
Backspace operate on whole characters, including emoji.

Mouse controls use [SGR terminal mouse reporting](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html#h2-Mouse-Tracking)
in the alternate screen. The app restores the shell screen and disables mouse
tracking on exit. In terminals that support it, hold Shift while selecting text
to use the terminal's normal copy selection. Keyboard controls remain available.

For reliable selection, press **Ctrl+Y** (or enter `/copy`). This freezes the focused
pane's transcript in a single column and disables mouse tracking. Drag to select,
then use your terminal's Copy menu/shortcut, such as Ctrl+Shift+C on many Linux
terminals. PgUp/PgDn, arrows, and Home/End navigate the snapshot. Code is shown in
full, without folding controls or decorative borders. Esc or Ctrl+Y restores the
split view, mouse controls, draft, and previous scroll position. Agents may keep
working while you copy; new output appears after you return. Copy mode uses your
terminal's clipboard support and does not overwrite the clipboard itself.

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

Commands: `/help`, `/copy`, `/model [MODEL_ID|default]`, `/effort [LEVEL|default]`, `/split [codex|claude]`, `/agent [codex|claude]`, `/pause`, `/resume`, `/to <agent name>|both`,
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
checkpoint is future work. Permissions can be changed in the current saved session.
Adding a peer reopens prior agent agreements for the enlarged roster while retaining
user decisions. Validate an outstanding build integration candidate before adding
a peer. A peer joining an already validated build triggers fresh agreement and
validation before that expanded session can declare completion.

Each collaborative writable turn receives one active task owned by that agent. The coordinator
rejects completion of a sibling task on that turn. It commits the current owned
worktree snapshot after task completion; it cannot prove that every changed file
semantically belongs to that task. Review the resulting diff.

Collaborative build completion starts **agent-owned integration**. Git merges finalized
agent commits into a separate integration worktree. Conflicts stay in that worktree
for the integration owner to resolve; dependency synchronization during implementation
still aborts conflicting merges and pauses without overwriting work.

One peer owns resolving integration conflicts, fixing cross-component problems, and
running the relevant combined checks. It can consult the other peer about ambiguous
intent. When it reports readiness, the harness commits the resolved candidate and
checks that every completed task commit is included. The other peer then reviews
that exact Git revision with read-only access, including the combined diff and the
owner's validation evidence. Review findings return to the owner for fixes and fresh
validation. A changed or dirty candidate cannot receive a stale approval.

The initial rejected review plus two unsuccessful fix rounds escalates to you.
Either peer can also report a product decision that only you can make. Resolve it with:

```text
/resolve integration Keep the documented v1 API behavior.
/resume
```

Your resolution remains part of the integration instructions. Pause/resume retains
ownership, review revision, validation evidence, and pending questions. Integration
uses the same turn/time budgets and permission controls as the rest of the session.
Successful peer review completes the candidate; it **does not merge or push your
original branch**. Adopt the integration branch through your normal Git workflow.

Validation commands are selected and executed by the owner; the harness records its
reported evidence rather than independently proving test coverage or correctness.
Older manual integration checkpoints can be resumed into this workflow when two
native peers are available. Legacy/manual adapters and single-peer checkpoints retain
`/accept <your validation evidence>` support.

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

After the interactive view closes, the shell shows a copyable command for this
session. Local sessions use `--resume`; attached/background sessions use `--attach`.
The command includes the absolute launcher and state paths, including development
loaders when started through `npm run dev`, so it works from another directory.

Native peer chats receive descriptive names starting with `Agent duet`, for example
`Agent duet · search · Codex 1 · Design search suggestions · 61ea67d1`.
Names use the project, peer name, first user message, and short harness session ID;
they require no extra model call. Titles are applied when each peer next runs,
including resumed chats. Two peers of the same provider retain distinct names.
The adapters use Codex's supported
[`thread/name/set`](https://learn.chatgpt.com/docs/app-server) method and Claude's
[`--name`](https://code.claude.com/docs/en/cli-reference) option. Unsupported Codex
title updates produce an activity notice without failing the conversation.

Default allowances are 30 provider turns (shared by both agents) and 30 minutes
of active wall time **between user messages**. Sending a direct message,
collaboration message, or decision resolution resets both counters. Agent replies,
tool calls, and integration phase changes do not reset them. Paused time does not
count. The header shows usage for the current allowance; lifetime totals remain
in the saved session.

Use `/limits` to show settings, `/limits turns 50` to change the turn cap, or
`/limits minutes 15` to change active minutes (decimals allowed). Settings persist
with the session and apply immediately, including in attached/background sessions.
Changing a limit preserves current usage; lowering it below that usage pauses
work. Messages submitted while explicitly paused stay queued until `/resume`.
Explicit `/resume` of an exhausted allowance renews both counters using your
configured limits; agents never renew their own allowance.

Startup flags `--max-turns N` and `--max-minutes N` set the same limits. These are
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
