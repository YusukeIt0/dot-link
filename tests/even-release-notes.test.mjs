import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const reviewNote = 'Review note: The `location` permission is used for optional phone location sharing via the Even SDK (`startAppLocationUpdates()` and `getAppLocation()`).';

test('the newest Even notes fit Even Hub\'s 500-character field and end with the review note', () => {
  const notes = readFileSync(new URL('../docs/even-release-notes.md', import.meta.url), 'utf8');
  const newest = notes.split(/^## \d+\.\d+\.\d+\n/m)[1].split(/^## /m)[0].trim();
  assert.ok(newest.length <= 500, `newest Even notes are ${newest.length} characters; Even Hub truncates at 500`);
  assert.ok(newest.endsWith(reviewNote), 'the review note must be last and complete');
  const {version} = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8'));
  assert.match(notes, new RegExp(`^## ${version.replaceAll('.', '\\.')}\\n`, 'm'), 'notes exist for the packaged version');
});
