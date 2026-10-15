import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps retained renderer memory bounded across thousands of unique text updates', async () => {
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--expose-gc', '--max-old-space-size=256', resolve('tests/fixtures/renderer-memory.mjs')],
    { timeout: 45_000, maxBuffer: 64 * 1024 });
  const { samples } = JSON.parse(stdout) as { samples: number[] };
  expect(samples).toHaveLength(3);
  // Warm the caches first. Another 16k updates must not keep accumulating text.
  expect(Math.max(...samples.slice(1)) - samples[0]).toBeLessThan(20 * 1024 * 1024);
}, 50_000);
