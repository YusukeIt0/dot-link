// macOS-only. Creates/deletes one isolated temporary Keychain; no real credentials.
import {mkdtemp, rm, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {stdio: 'inherit', timeout: 30000});
  if (result.status !== 0) throw new Error('Isolated Keychain test failed; macOS Keychain access is required');
};
const directory = await mkdtemp(join(tmpdir(), 'dot-link-stt-keychain-'));
await mkdir('.runtime/swift-module-cache', {recursive: true});
try {
  for (const updated of [false, true]) {
    const binary = join(directory, updated ? 'updated' : 'original');
    run('/usr/bin/xcrun', ['swiftc', '-suppress-warnings', '-module-cache-path', resolve('.runtime/swift-module-cache'), ...(updated ? ['-D', 'STT_UPDATED'] : []), 'native/DotLinkSetup/STTCredentials.swift', 'tests/stt-keychain.swift', '-o', binary]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', 'app.tripsurf.dotlink.stt-test', binary]);
  }
  run(join(directory, 'original'), [directory, join(directory, 'updated')]);
} finally {
  // The Swift harness deletes its own Keychain. Also remove it after an assertion
  // failure so the Keychain search list cannot keep a stale test entry.
  spawnSync('/usr/bin/security', ['delete-keychain', join(directory, 'isolated.keychain-db')], {stdio: 'ignore', timeout: 5000});
  await rm(directory, {recursive: true, force: true});
}
