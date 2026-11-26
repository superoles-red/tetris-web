// Короткая версия дифференциального CPU-теста для `node --test tests/`:
// наш перекомпилированный 6502 против JSNES 2.1.0 на синтетической программе.
// Полный прогон (5 seeds × 3000): node tests/cpu-differential.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDifferential } from './cpu-differential.mjs';

test('CPU differential: наш WASM совпадает с JSNES (2 seeds × 500)', { timeout: 120000 }, async () => {
  const report = await runDifferential({
    seeds: [1, 2],
    steps: 500,
    includeJmpIndirect: true,
    checkCycles: true,
    saveFailure: false,
  });
  for (const result of report.results) {
    assert.ok(
      result.passed,
      `seed ${result.seed}: ${result.reason} на шаге ${result.step} ` +
        `${result.instruction?.mnemonic ?? ''} $${(result.instruction?.address ?? 0).toString(16)} ` +
        JSON.stringify({ before: result.before, after: result.after, ram: result.ramMismatch }),
    );
  }
});
