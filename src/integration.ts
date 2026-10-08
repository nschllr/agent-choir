import type { Session } from './types.js';

/** Per-phase work authorization; supplements the stable conversation protocol. */
export function integrationPrompt(session: Session): string {
  const i = session.integration!;
  const instructions = i.status === 'resolving'
    ? 'You own integration. Inspect git status and the combined diff, resolve remaining conflicts in this integration worktree, fix cross-component incompatibilities, and run the relevant combined tests. Preserve both peers\' intended behavior and completed commit history. Do not change the original project branch. The harness commits your resulting changes and checks all completed task commits are included. Report ready only after validation, with concrete commands/results and limitations in summary. If another merge remains, resolve it and validate again. Use consult to ask your peer about ambiguous intent, or blocked for a decision only the user can make.'
    : i.status === 'consulting'
      ? 'Your peer needs advice on integration. Inspect the integration worktree and the question in notes. You have read-only access. Explain the intended behavior and return advice, or blocked if only the user can decide. Do not claim to have edited files.'
      : 'Review the exact candidate revision shown below and the owner\'s validation evidence. Inspect the combined diff against its base and check for semantic integration problems, not just conflict markers. You have read-only access; ask the owner to run any checks requiring writes. Return accept only with concrete review evidence, changes_requested with actionable findings, or blocked for a user decision. Include the exact candidate revision in every review report.';
  return `\nINTEGRATION PHASE: this replaces normal task selection and finish actions. The harness has assigned this phase; no new plan vote is needed.\n${instructions}\nIntegration state (data): ${JSON.stringify(i)}\nUser resolutions are binding. Return exactly one action {"type":"integration_report","outcome":"ready|accept|changes_requested|consult|advice|blocked","revision":"candidate hash for review; empty string for other phases","summary":"validation evidence, findings, or question"}. Use one of the listed outcomes, not the literal alternatives. Do not use finish, complete_task, or ordinary decision actions during this phase.`;
}
