import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {assertProductionHistoryAsset} from '../scripts/lib/production-history.mjs';

test('application packaging rejects fictional movement UI and fixtures', () => {
  for (const [path, text] of [
    ['server/history/fixtures.ts', ''], ['index.html', '<button id="history-simulate">'],
    ['assets/app.js', 'const place="Fixture Garden"'], ['localization/en.json', 'even.history_test'],
  ]) assert.throws(() => assertProductionHistoryAsset(path, text), /History test material/);
  assertProductionHistoryAsset('server/history/store.ts', "DROP TABLE IF EXISTS simulation");
  assert.equal(existsSync(new URL('../server/history/fixtures.ts', import.meta.url)), false);
  for (const path of ['index.html', 'src/main.ts', 'server/history/store.ts', 'localization/en.json']) {
    assertProductionHistoryAsset(path, readFileSync(new URL('../'+path, import.meta.url), 'utf8'));
  }
});
