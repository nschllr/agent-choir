# Architecture

Models reason about the task; ordinary code validates their structured actions and
enforces state transitions, permissions and Git operations.

```text
Ink terminal / headless CLI / attached terminal
                    |
             ChoirController
             /     |      \
       protocol  SQLite   GitWorkspaceManager
          /        state       |
 ClaudeProvider / CodexProvider |-- agent-1 worktree
       |                       |-- agent-2 worktree
 native CLI + supervisor       |-- integration worktree
```

## Modules

| Module | Responsibility |
| --- | --- |
| `types.ts` | Shared contracts |
| `agents.ts` | Instance identities, roster, display names |
| `protocol.ts` | Response schema and strict validation |
| `engine.ts` | Decision transitions, task graph, completion gates |
| `context-policy.ts` | Versioned harness instructions |
| `context-delivery.ts` | Per-instance message/state deltas |
| `context-memory.ts` | Project memory and private `.agent/` projections |
| `controller.ts` | Scheduling, steering, limits, persistence, integration |
| `providers/` | Native CLI adapters and process supervision |
| `workspaces.ts` | Worktrees, task commits, integration, adoption, cleanup |
| `store.ts` | SQLite snapshots, ownership locks, recovery |
| `background.ts` | Unix socket transport to background workers |
| `ui/` | Panes, pickers, composer, checkpoints |
| `demo.ts` | Scripted offline provider |

## Protocol

- A session has one or two **instances** (ID + provider). Native sessions, votes,
  tasks and worktrees are keyed by instance, so two Codex instances stay independent.
- **Chat:** only addressed instances run, once per request; replies stay private.
  **Collaboration:** history is shared and turns are scheduled automatically.
- Each reply is `{message, actions}`. Actions: `propose`, `position`,
  `complete_task`, `finish`, `yield`. Unknown fields or malformed actions are
  rejected, and a response's actions apply atomically.
- A plan is a versioned decision with task IDs, owners and dependencies (cycles
  rejected). All instances must accept the current version; revisions clear votes.
  The first unresolved cycle plus two more escalate to the user.
- `yield` messages are shown but not delivered to the peer. A yielded instance
  only runs again on new input or changed state.
- This proves that approvals were recorded, not that agents reasoned well.

## Permissions

- Write access requires an agreed plan, settled decisions and a ready task owned
  by that instance; each write turn gets exactly one task.
- **Codex:** native read-only / workspace-write policies limited to the assigned
  worktree, no tool network; refuses effective MCP or hook configuration.
- **Claude:** explicit tool list. Read-only gets Read/Glob/Grep; Project adds
  sandboxed Bash with fail-if-unavailable. Hooks, MCP and subagents are off.
- Neither adapter touches credentials; subscription login is checked before each turn.

## Workspaces

- The first build snapshots the checkout (including uncommitted files) into a
  private commit at `refs/choir/SESSION_ID/base`. Branches `choir/SESSION_ID/INSTANCE_ID`
  start there; worktrees live under `STATE_DIR/worktrees/SESSION_ID/`.
- Task completion commits the owned worktree (local identity, no hooks or signing)
  and records the SHA. Dependencies and integration merge those recorded commits,
  never live branch tips.
- Integration merges into a separate worktree. One agent resolves and validates,
  the peer reviews the exact revision.
- Adoption runs `git apply` of `base..candidate` onto the original checkout. It is
  all-or-nothing and leaves HEAD and the index untouched, then removes the session's
  refs and worktrees. Unclear orphaned worktrees are reported, never deleted.

## Persistence and processes

- SQLite (WAL, full sync, private permissions, unencrypted) stores whole validated
  snapshots. Ownership locks allow one controller per session; interrupted sessions
  reopen paused.
- Each instance has a saved delivery cursor (native ID, protocol version, hashes of
  sent messages and state). It is marked in-flight before a call, so an
  interruption triggers a conservative full replay instead of lost input.
- Every turn has an abort signal and generation ticket; stale output is ignored.
  Cancellation does not roll back executed commands.
- A supervisor process owns native subprocesses and kills descendants when the
  harness exits. This is not a container boundary.
- Not supported: remote/multi-user, Windows, cost accounting.

## Provenance

Original MIT source. The `.agent/` memory layout was informed by
[shared-agent-memory](https://github.com/nschllr/shared-agent-memory/tree/ccea8646488a2df3d9dff4dfb2c7ecc2330c38f9);
no code or instruction text was copied.
