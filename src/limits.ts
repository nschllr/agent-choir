import type { Session, SessionLimits } from './types.js';

export function validLimits(value: unknown): value is SessionLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => key === 'maxTurns' || key === 'maxMinutes') &&
    typeof v.maxTurns === 'number' && Number.isSafeInteger(v.maxTurns) && v.maxTurns > 0 &&
    typeof v.maxMinutes === 'number' && Number.isFinite(v.maxMinutes) && v.maxMinutes > 0 &&
    v.maxMinutes * 60_000 <= Number.MAX_SAFE_INTEGER;
}

/** Lifetime totals remain intact; legacy snapshots count from the session start. */
export function limitUsage(session: Session): { turns: number; elapsedMs: number } {
  return {
    turns: session.turns - (session.allowanceStart?.turns ?? 0),
    elapsedMs: session.elapsedMs - (session.allowanceStart?.elapsedMs ?? 0),
  };
}
