# Testing

## Automated checks

```sh
npm ci
npm run check   # typecheck, build, Vitest
```

Tests use protocol fixtures, scripted providers, disposable Git repos and local
subprocesses. They make no model calls and read no logins. PTY tests need Python 3
and are skipped without it.

| Area | Covers |
| --- | --- |
| Protocol / engine | Schema validation, exact-version votes, escalation, task graph gates |
| Controller | Scheduling, limits, steering, cancellation, yield, integration |
| Workspaces | Snapshots, dependencies, conflicts, recovery, adoption, cleanup |
| Store / context | Persistence, ownership, incremental delivery, project memory |
| Providers | Native protocol handling, config guards, subprocess cleanup |
| UI / PTY | Panes, composer, routing, scrolling, mouse, copy mode, code folding |

Fixtures show behavior against modeled protocols, not real model quality or
compatibility with future CLI releases.

## Offline smoke test

```sh
npm run build
node dist/cli.js --demo --headless --json --state-dir /tmp/agent-choir-smoke
npm run demo
```

The JSON should show both scripted agents, their decisions and completion. For
lifecycle checks, start a demo with `--detach`, then `--attach`, pause/resume and
detach again; the session ID and history must survive.

## Real-provider acceptance exercise

Manual and uses real provider usage. Run `--doctor` first; use
`--claude-model claude-haiku-4-5-20251001` to keep it cheap. Work in a small
throwaway repo:

1. **Discuss:** `--collaborate` a design question; agents exchange messages without you.
2. **Steer:** change requirements (queued, then immediate); the next reply follows them.
3. **Plan:** force a real decision; check exact-version acceptance or escalation.
4. **Build:** two independent tasks plus a dependent one; check branches and that your checkout is untouched.
5. **Integrate:** check the candidate and its review, then `/adopt`.
6. **Lifecycle:** pause, exit, resume, limits, detach/attach, provider failure.

Note CLI versions, OS and anything unexpected. Don't share credentials or raw session databases.
