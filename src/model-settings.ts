import type { ModelCatalog, ModelSettings, ProviderKind } from './types.js';

export const validModel = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:\[1m\])?$/.test(value);
export const validEffort = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
export const claudeEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export const codexEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function validModelSettings(value: unknown): value is ModelSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const settings = value as ModelSettings;
  return Object.keys(value).every(key => key === 'model' || key === 'effort') &&
    (settings.model === null || validModel(settings.model)) && (settings.effort === null || validEffort(settings.effort));
}
export function fallbackCatalog(provider: ProviderKind): ModelCatalog {
  return provider === 'claude' ? {
    models: ['haiku', 'sonnet', 'opus', 'fable'].map(id => ({ id, name: id[0].toUpperCase() + id.slice(1), efforts: claudeEfforts })),
    notice: 'Claude aliases follow your native CLI. Model access and effort limits are enforced by Claude.',
  } : { models: [], notice: 'Model discovery is unavailable. Enter a model ID, or keep the native defaults.' };
}
