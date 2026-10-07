import { describe, expect, it } from 'vitest';
import { validModelSettings, validModel } from '../src/model-settings.js';
import { parseCodexModels } from '../src/providers/codex-models.js';

describe('model settings validation', () => {
  it('accepts explicit settings and resets but rejects malformed transport payloads', () => {
    expect(validModelSettings({ model: 'opus[1m]', effort: 'high' })).toBe(true);
    expect(validModelSettings({ model: null, effort: null })).toBe(true);
    for (const value of [null, [], {}, { model: '', effort: null }, { model: null, effort: '' }, { model: null, effort: null, extra: true }]) expect(validModelSettings(value)).toBe(false);
    for (const model of ['-flag', 'with spaces', 'x'.repeat(129), 'bad\nname']) expect(validModel(model)).toBe(false);
  });
  it('uses the native catalog effort list and excludes hidden and malformed model entries', () => {
    const models = [{ model: 'model-a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'future_level' }, {}], defaultReasoningEffort: 'low' }, { model: 'hidden-model', hidden: true }, { model: '--bad' }];
    expect(parseCodexModels(models)).toEqual([{ id: 'model-a', name: 'A', efforts: ['low', 'future_level'], defaultEffort: 'low' }]);
    expect(parseCodexModels(models, true)).toHaveLength(2);
    expect(() => parseCodexModels(null)).toThrow('catalog');
  });
});
