import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { macClientVersion } from '../server/mac-client-version.ts';

test('only the enclosing Dot Link Mac app supplies the optional running version and Beta marker', {skip: process.platform !== 'darwin'}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'dot-link-client-version-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const info = pathToFileURL(join(dir, 'Info.plist'));
  const identity = {CFBundleIdentifier: 'app.tripsurf.dotlink.mac', CFBundleShortVersionString: '0.5.8', DotLinkBeta: false};
  assert.equal(await macClientVersion(info), undefined);
  for (const [fields, expected] of [
    [{}, '0.5.8'], [{DotLinkBeta: true}, '0.5.8 Beta'],
    [{CFBundleIdentifier: 'another.app'}, undefined], [{CFBundleShortVersionString: ''}, undefined],
  ] as const) {
    await writeFile(info, JSON.stringify({...identity, ...fields}));
    assert.equal(await macClientVersion(info), expected);
  }
});
