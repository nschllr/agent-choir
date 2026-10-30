# Agent Choir plan

Goal: a local, subscription-backed terminal workspace where two equal coding agents
discuss, plan and implement together. Agents vote on versioned decisions,
ordinary code enforces the outcome, and the user settles disagreements.

## Done

- Single-agent start, optional peer, any provider combination
- Direct chat and autonomous collaboration with structured, versioned decisions
- Native Codex and Claude adapters with permission modes and process supervision
- Isolated worktrees, agent-owned integration with peer review, adoption and cleanup
- Persistence, background workers, incremental context delivery, project memory
- Offline demo and test suite

## Open

- Run the full [real-provider acceptance exercise](docs/testing.md#real-provider-acceptance-exercise).
- Let unrelated tasks continue while a decision is escalated (today the whole session pauses).
- Check whether structured decisions keep real disagreements, including after steering and resume.
- Stronger containment than process supervision for daemonizing code.
