import type { PermissionSettings, Session } from './types.js';

export const permissionModes = ['read-only', 'project', 'full'] as const;
export const permissionLabels = { 'read-only': 'Read-only', project: 'Project edits', full: 'Full access' };
export function sessionPermissions(session: Pick<Session, 'scope' | 'demo' | 'permissions'>): PermissionSettings {
  return session.demo ? { mode: 'read-only', additionalDirectories: [] }
    : session.permissions ?? { mode: session.scope === 'build' ? 'project' : 'read-only', additionalDirectories: [] };
}
export function validPermissions(value: unknown): value is PermissionSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as PermissionSettings;
  return Object.keys(settings).every(key => key === 'mode' || key === 'additionalDirectories')
    && permissionModes.includes(settings.mode) && Array.isArray(settings.additionalDirectories)
    && settings.additionalDirectories.length <= 32
    && settings.additionalDirectories.every(path => typeof path === 'string' && path.trim().length > 0 && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path));
}
