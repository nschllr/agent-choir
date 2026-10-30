# Agent Choir guide

Usage reference. The [README](../README.md) has the short version;
[architecture](architecture.md) explains the design.

## Setup

Install Git plus [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and/or
[Claude Code](https://code.claude.com/docs/en/setup) on `PATH`, and sign in with
your subscription:

```sh
codex login
claude
node dist/cli.js --doctor   # checks binaries; no credentials read, no model calls
```

- Agent Choir runs the unmodified native CLIs. It never handles credentials or
  calls model APIs; API-key and alternate-provider setups are refused, never used
  as a billing fallback.
- Linux only for now. Claude writes in Project mode need the native
  [Bash sandbox](https://code.claude.com/docs/en/sandboxing) (`bwrap`, `socat`);
  without it the turn fails rather than running unsandboxed.
- Claude hooks/MCP are disabled and its tools limited. Codex refuses to run if
  MCP servers or hooks are enabled in its effective config; use a dedicated
  project config without them (it must also apply to generated worktree paths).

## Sessions

```sh
npm run dev                                   # empty Codex chat
npm run dev -- --read-only                    # no edits
npm run dev -- --agent claude --claude-model haiku
node dist/cli.js --project /path/to/repo --peer claude --collaborate \
  "Implement user search and verify it against the existing tests."
```

- **Chat:** one agent answers you directly and may edit the project (unless
  read-only). No model call runs before your first message.
- **Add a peer:** **Ctrl+N**, pick Codex or Claude. Two of the same provider show
  as *Codex 1* / *Codex 2*, each with its own native session and worktree.
- **Recipient:** **Tab** cycles agents and *both*. Each addressed agent replies once;
  replies don't wake the other agent. Read-only turns run in parallel, write turns
  one at a time.
- **Collaboration:** **Ctrl+B** or `/collaborate [task]` (`/chat` to leave). Enter
  shares the history and starts autonomous exchanges between both agents.
  Implementation then requires an agreed plan, assigned tasks and isolated worktrees.
- **Yield:** an agent can reply without asking for a peer response. When nobody has
  new input or ready work, the session returns to the composer.
- Without `--collaborate`, a command-line brief goes only to the first agent.

## Models

- **Ctrl+R** or `/model` opens the picker for the focused pane: ↑/↓ model, ←/→
  effort, Enter save, Esc cancel. *Custom model ID* and *Native default* are available.
- Commands: `/model MODEL_ID|default`, `/effort LEVEL|default`.
- Flags: `--claude-model`, `--codex-model`, `--claude-effort`, `--codex-effort`.
- Settings are per pane, apply from the next turn and persist across resume/attach.
  Codex choices come from its native catalog; listing them costs no model turn.
- For cheap Claude test turns use `--claude-model claude-haiku-4-5-20251001`; see the
  [real-provider acceptance exercise](testing.md#real-provider-acceptance-exercise).

## Permissions

**Ctrl+L** or `/permissions` sets access for both agents:

| Mode | Access |
| --- | --- |
| Read-only | Inspect files only. Claude has no shell. |
| Project (default) | Write in the project/worktree and added directories; no shell network. |
| Full access | Filesystem and network as your user, no sandbox. |

- In the picker, **A** adds and **D** removes a directory. Commands:
  `/permissions project|full|read-only`, `/permissions add PATH`, `/permissions remove PATH`.
- Flags: `--read-only`, `--permissions MODE`, `--allow-dir PATH`.
- Saving stops running turns and keeps their work queued; **Ctrl+P** resumes.

## Keys and commands

| Key | Action |
| --- | --- |
| Enter / Alt+Enter, Ctrl+J | Send / newline |
| Ctrl+G | Choose the first agent (before the first message) |
| Ctrl+N | Add a second agent |
| Ctrl+B | Toggle collaboration (keeps the draft) |
| Tab / Shift+Tab | Change recipient |
| Ctrl+S | Queued vs immediate steering (`/steer queued\|immediate`) |
| Ctrl+P | Pause / resume |
| Ctrl+O | Show tool activity |
| Ctrl+F, click | Focus a pane (click also selects the recipient in chat) |
| Ctrl+R / Ctrl+L | Model / permissions |
| Ctrl+Y or `/copy` | Frozen single-column view for selecting text |
| Ctrl+X / Ctrl+K | Expand / select a folded code block |
| PgUp/PgDn, Alt+↑/↓, wheel | Scroll |
| Home / End | Oldest messages / back to live output |
| Ctrl+U | Clear the composer |
| Ctrl+C | Pause and exit |

Other commands: `/help`, `/to NAME|both`, `/split`, `/agent`, `/pause`, `/resume`,
`/resolve ID text`, `/accept evidence`, `/adopt [keep]`, `/limits`, `/detach`, `/quit`.

**Steering:** queued steering interrupts at the next tool boundary; immediate
steering cancels the turn and restarts with your message. Neither undoes commands
that already ran.

## Decisions and integration

- Agents propose, accept, object or request evidence through structured actions.
  Plain-text agreement unlocks nothing; every agent must accept the exact current
  plan version.
- After the first unresolved round plus two more, the decision escalates to you:
  `/resolve ID your choice`, then `/resume`. Resolving a plan makes the agents
  propose a replacement that honors your choice.
- Each write turn works on one assigned task in its own worktree, branched from a
  private snapshot of your checkout (uncommitted changes included). Your files,
  branch and index stay untouched. Needs a Git repo with at least one commit.
- When tasks finish, one agent merges the results in an integration worktree,
  resolves conflicts and runs checks. The other reviews that exact revision.
  Two failed fix rounds escalate to you (`/resolve integration ...`).
- The harness verifies Git state and records reported evidence. It does not prove
  the code is correct; review the diff.

## Adopting results and cleanup

```sh
agent-choir --adopt SESSION_ID [--keep]   # or /adopt [keep] in the session
agent-choir --clean SESSION_ID
agent-choir --clean-all
```

- `/adopt` applies the accepted result to your checkout as **uncommitted changes**;
  review with `git diff` and commit as you like. If a file the agents changed was
  also changed in your checkout, nothing is applied.
- Afterwards the session's worktrees, `choir/SESSION_ID/*` branches and
  `refs/choir/SESSION_ID/base` are removed, unless you pass `keep`.
- `--clean-all` skips unfinished builds; `--clean ID` removes them anyway. Both keep
  the transcript.

## Sessions, limits and background work

```sh
node dist/cli.js --list
node dist/cli.js --resume SESSION_ID
node dist/cli.js --detach --project /path/to/repo --read-only "Explore alternatives."
node dist/cli.js --attach SESSION_ID
```

- Exiting pauses. `--resume` reopens paused; Ctrl+P or `/resume` continues.
  On exit the shell prints a ready-to-copy resume command.
- `/detach` or `--detach` keeps a worker running in the background; reconnect with
  `--attach`. Closing an attached UI pauses the worker.
- Limits: 30 turns and 30 active minutes **per user message** (`/limits turns N`,
  `/limits minutes N`, `--max-turns`, `--max-minutes`). Hitting a limit pauses;
  `/resume` renews it.
- State: `$XDG_STATE_HOME/agent-choir` (default `~/.local/state/agent-choir`),
  override with `--state-dir`. Private but not encrypted; keep it out of repos.
- `--native-log` writes native CLI stderr to `STATE_DIR/logs/native-SESSION_ID.log`
  for debugging. It may contain account details; delete it afterwards.
- After updating, run `npm ci && npm run build` before resuming.

## Context and project memory

- Each agent keeps its native conversation; later turns send only new messages and
  changed state. Nothing is compacted per turn.
- Session state is mirrored to `STATE_DIR/context/SESSION_ID/.agent/` (instructions,
  decisions, task board, handoff). SQLite remains authoritative.
- Existing project `.agent/` files (`INSTRUCTIONS.md`, `PROJECT-INSTRUCTIONS.md`,
  `environment.md`, `shared-state.md`, `decisions.md`, `task-board.md`, `handoff.md`)
  are passed in as context, max 64 KiB each and 256 KiB total. They never override
  permissions and are never modified.
