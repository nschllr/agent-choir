# Agent Duet

A local terminal workspace that starts with one agent and adds a second when you
want a peer. Choose Codex or Claude for each pane, including two instances of the
same provider. Agents brainstorm, make explicit decisions, and work on the same
project as equal peers. Discuss, plan, and implement in one session; use `--read-only`
when you want to prevent edits. You settle unresolved decisions. The coordinator is
ordinary software, not a third model judging their conversation.

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
and never edits the selected project. `node dist/cli.js --demo --headless --json`
prints the final state without a terminal UI.

There is no published npm package yet. Invoke `node dist/cli.js` after building,
or use `npm run dev --` during development. Examples using `agent-duet` assume you
have made that executable available yourself.

## Quick start with native agents

Install Git and the native CLIs you intend to use,
[Codex CLI](https://learn.chatgpt.com/docs/codex/cli) and
[Claude Code](https://code.claude.com/docs/en/setup), and sign in through them
with your existing subscription accounts:

```sh
codex login
claude
node dist/cli.js --doctor
```

Agent Duet starts the unmodified native programs and resumes their native sessions.
It never brokers credentials or calls model APIs directly; it refuses API-key and
alternate-provider environments rather than falling back to API billing. Claude
project-mode writes need the native Bash sandbox (`bwrap` and `socat`).

```sh
node dist/cli.js                                  # empty Codex chat in the current directory
node dist/cli.js --agent claude --read-only       # Claude, no project edits
node dist/cli.js --project /path/to/repo --peer claude --collaborate \
  "Implement user search and verify the result against the existing tests."
```

## A session in brief

- **Chat** with one agent. Press **Ctrl+N** to add a peer; **Tab** picks the recipient.
- **Ctrl+B** toggles collaboration. Agents then exchange messages automatically,
  propose versioned plans, and must each explicitly accept the same version before
  any implementation task starts. Unresolved disagreements escalate to you.
- **Implementation** happens in isolated Git worktrees from a private snapshot of
  your checkout. One peer integrates and validates, the other reviews. Your branch
  is never touched.
- **`/adopt`** applies the accepted result to your checkout as uncommitted changes
  and removes the session's branches and worktrees. Review and commit as usual.
  `--clean-all` tidies sessions you never adopted.
- **Ctrl+L** sets permissions (read-only, project, full), **Ctrl+R** sets each
  pane's model and effort, **Ctrl+P** pauses, `/detach` runs in the background.

The [guide](docs/guide.md) covers every control, command, and flag, including
permissions, model selection, decisions, integration, limits, background workers,
and the `--native-log` diagnostics switch.

## Documentation

- [Guide](docs/guide.md): complete usage reference.
- [Architecture](docs/architecture.md): module boundaries, protocol, workspace
  lifecycle, persistence, and the limits of what the coordinator proves.
- [Testing](docs/testing.md): automated coverage, offline smoke test, and the
  separate real-provider acceptance exercise.

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
