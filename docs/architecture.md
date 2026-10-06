# Architecture

Agent Duet separates terminal presentation, deterministic coordination, native
provider execution, and Git workspace operations. Models reason about the task;
the coordinator validates their declared positions and allowed state transitions.

```text
Ink terminal / headless CLI / attached terminal
                    |
             DuetController
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
| `types.ts` | Shared session, provider, controller, and workspace contracts |
| `agents.ts` | Provider-independent instance identities, roster validation and display names |
| `protocol.ts` | Structured response schema and strict runtime validation |
| `engine.ts` | Immutable decision transitions, task graph validation, completion gates, prompts |
| `controller.ts` | Scheduling, steering, cancellation, limits, persistence, integration checkpoint |
| `providers/` | Native CLI protocol adapters, output decoding, process supervision |
| `workspaces.ts` | Durable per-agent worktrees, task finalization, dependency and candidate integration |
| `store.ts` | Private SQLite snapshots, validation, process ownership locks, recovery |
| `background.ts` | Private local Unix socket transport to intentional background workers |
| `ui/` | Single/split panes, provider pickers, named recipients, composer and checkpoints |
| `demo.ts` | Explicitly scripted offline provider |

## Collaboration protocol

A session contains one or two instances, each with a stable ID and a provider.
Native sessions, models, tasks, votes, streams and worktrees use the instance ID,
so two Codex instances remain independent. Saved sessions without a roster retain
their legacy Claude/Codex identities.

Startup presents an idle single-agent composer. Sessions persist an `interaction`
mode and a `pendingRecipients` queue. In `chat`, only addressed agents run, once
per pending request, and replies stay in their own panes. Independent recipients
run concurrently, including when a new recipient is addressed during another turn.
Each reply is applied and persisted as it finishes; slow peers do not block further
chat with an idle instance. State transitions remain serialized, and in-flight
requests reserve turn allowance so concurrent starts cannot exceed the limit.
Checkpoints cancel unfinished turns while preserving their pending requests.
Consuming the queue
returns to input; `awaitingInput` distinguishes this from a deliberate pause.
Adding a peer pauses active work and reopens agent agreements for the larger
roster, without sharing preceding message text or scheduling model calls. User decisions and
pending user checkpoints survive. An outstanding integration checkpoint must be
validated before changing its roster. Opening the picker itself never calls a model.

The UI keeps a composer mode, initially matching the session's runtime mode.
Ctrl+B or `/collaborate` selects collaboration without sending the draft. Enter
then calls `collaborate(task)`, sharing preceding history and starting bounded
autonomous scheduling. `/collaborate <task>` combines selection and submission.
The composer selection survives follow-ups within the open UI. Turning it off
with Ctrl+B or `/chat` pauses any active collaboration and preserves the draft;
a subsequent direct submission waits for cancellation to finish before sending.

In direct mode, Enter calls `send`, which switches the runtime to `chat`;
selecting both queues one answer per instance without peer forwarding.
Per-recipient revisions preserve newer queued instructions when an older turn
finishes. Decisions and task state are shared across both modes. Legacy snapshots
without a roster retain autonomous scheduling until a direct submission.

A provider returns `{message, actions}`. The message is user or peer conversation.
Actions are `propose`, `position`, `complete_task`, and `finish`. Envelopes with
unknown fields, coercive values, unknown actions, or malformed task structures
are rejected. Applying actions is atomic: a failed later action cannot partially
commit earlier decisions or task completion.

In collaboration, two agents beginning together receive independent initial snapshots and must return
no decision actions. A joining agent instead receives the existing shared context.
Subsequent turns see addressed conversation and shared state.
Ready implementation work can run for both agents concurrently; ordinary discussion
alternates. Scheduling and state application remain controlled by application code.

A plan is one versioned decision. Proposing does not imply acceptance. All active instances
must explicitly accept the current version; an older acceptance is rejected.
A revision clears positions. Accepted plans carry task ids, owners, and dependencies;
duplicate ids, unknown dependencies, and cycles are invalid.

Once every active instance's position is recorded, either objection or a request for evidence
closes an unresolved cycle. The first unresolved cycle counts as the initial
objection; two further unresolved cycles escalate to the user. A revision keeps
the accumulated count, and clearing a partial objection/evidence cycle also counts
that cycle. Missing responses stay pending and session limits handle stalls.

The user can resolve a waiting decision. An ordinary decision records an explicit
override and cannot be reopened by either agent. A plan resolution instead clears
its obsolete tasks/votes, resets its discussion counter, and marks it as requiring
revision. Voting remains blocked until a concrete replacement plan is proposed.
The binding user choice stays recorded, and all active instances must accept the replacement
version before edits. Resolution pauses, rather than inventing peer acceptances.
All unsettled decisions currently
block implementation, and escalation pauses the entire session. Dependency-specific
continuation across decision checkpoints is not implemented.

This protocol proves that recorded approvals exist. It cannot prove an agent
faithfully declared every disagreement, carefully evaluated a proposal, or chose
a correct design. Real collaboration quality needs separate observation.

## Permissions and file access

New native sessions default to edits enabled, internally represented by `build`.
`--read-only` maps to `discuss`; offline demos default to read-only. The legacy
scope values remain in snapshots and compatibility CLI arguments, and saved
sessions keep their permissions. Conflicting flags and permission overrides on
resume/attach are rejected explicitly.

Edits-enabled sessions may finish discussion without creating a plan. An existing
decision must still be settled, and assigned implementation tasks must finish.
Legacy `plan` sessions retain the agreed-plan completion requirement. Integration
is needed only when an implementation plan has tasks, not for a plain discussion
or an agreed plan with no tasks.

Write access requires an agreed plan, settled decisions, and a dependency-ready
pending task owned by the agent. Each writable turn gets one assigned task;
sibling completion and plan revision during that turn are rejected. Read-only
sessions cannot obtain write access, even with an accepted task plan. Changing
saved permissions requires a new session.

Codex uses native app-server read-only or workspace-write policies. Writable roots
are limited to the assigned worktree and tool network access is disabled. Effective
MCP and hooks are checked because external native tools would not inherit the
ordinary shell filesystem sandbox. Unexpected interactive requests fail the turn.

Claude Code runs in streaming print mode with an explicit tool list. Read-only
turns have Read/Glob/Grep tools. Build turns add sandboxed Bash; direct Edit/Write,
NotebookEdit, nested Agent tools, MCP, hooks, and unsandboxed fallback are disabled.
The adapter requests native fail-if-unavailable sandbox behavior. Native CLI
compatibility is part of the permission boundary. Live read-only discussion and
sandboxed writes have been exercised on small Linux fixtures (see `testing.md`);
these functional checks do not prove containment of arbitrary code.

Neither adapter brokers credentials. Native CLIs own authentication. The harness
rejects known API/provider environment overrides and checks native account metadata
for a subscription login before starting a model turn.

## Workspace lifecycle

First build preparation records the clean original repository's HEAD. Agent branches
`duet/SESSION_ID/INSTANCE_ID` start from that stable base, independent of provider.
Worktrees live under `STATE_DIR/worktrees/SESSION_ID/`. The original checkout,
branch, and files remain unchanged; Git registers the additional worktrees.

Task completion commits the dirty owned worktree using command-local identity,
with hooks and signing disabled for those coordinator Git operations. It does not
alter global Git configuration. The task model has no file attribution manifest:
single-task assignment constrains declared work, but cannot prove every file change
belongs to that task.

Finalization records a commit SHA and completed task ids durably. Dependency and
integration work merge that finalized snapshot, not the live branch tip, preventing
later unfinished native commits from entering a candidate implicitly. A receiving
worktree integrates committed dependencies before it becomes writable. Dirty
receiving worktrees or conflicting dependencies stop synchronization.

The separate integration worktree merges completed snapshots from both peers.
On conflict, the attempted merge aborts and preserves original/agent branches.
Manual resolution in the integration worktree, followed by resume, retries the
checkpoint. A clean candidate still requires the user's combined checks and
`/accept` evidence. There is no automatic combined validator in this release and
no automatic merge into the user's original branch.

Worktrees are never removed automatically. Recovery can reconcile a worktree
created before metadata save only when its repository, path, expected branch,
stable base, and clean status match. Ambiguous orphan workspaces are preserved
and reported instead of being reset or deleted.

## Persistence and cancellation

SQLite saves whole validated session snapshots. The database uses WAL and full
synchronization. State directory permissions are private to the current user;
snapshots are not encrypted. Exclusive ownership locks stop concurrent controllers
from driving the same session. A saved running session opens paused after an
interruption. Native provider session ids are saved separately within that snapshot.

Every provider turn has an abort signal and a generation ticket. Pause, immediate
steering, or queued steering at a tool boundary invalidates its ticket. Late output
and stale results are ignored. Commands already executed remain in the worktree;
cancellation is not transaction rollback.

A separate supervisor owns native subprocesses. IPC disconnect triggers termination;
Linux supervision tracks descendant processes and process birth identity to reduce
accidental signaling of unrelated reused PIDs. This is process supervision, not a
complete cgroup/container boundary: arbitrarily daemonized descendants that escape
observation remain a limitation. Native protocols, messages, and sessions are also
subject to the providers' own lifecycle behavior.

Ordinary terminal exit pauses. Intentional detach launches a worker and exposes a
private Unix socket for attachment. Workers remain available at completion or a
checkpoint until their process is terminated; closing an attached UI pauses its
controller and disconnects, without terminating the worker. The first release has no remote multi-user
server, Windows support, automated cost accounting, or provider compatibility matrix.

## Provenance

This implementation is original MIT source.
