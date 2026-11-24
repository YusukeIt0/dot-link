import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {codesignSteps, developerIDProblems, developerTeam, findMachO, forbiddenEntitlements, signedExecutables, signingMode} from '../scripts/lib/mac-signing.mjs';

const app = '/build/Dot Link.app';
const bin = `${app}/Contents/Resources/payload/.runtime/bin`;
const sparkle = `${app}/Contents/Frameworks/Sparkle.framework`;
const developerID = {mode: 'developer-id', identity: 'Developer ID Application: Example (ABCDE12345)', keychain: '/k/signing.keychain-db'};

// Real `codesign -dvv` output shapes (paths shortened).
const released = `Executable=/tmp/node
Identifier=node
Format=Mach-O thin (arm64)
CodeDirectory v=20500 size=285904 flags=0x10000(runtime) hashes=8924+7 location=embedded
Signature size=9041
Authority=Developer ID Application: Example Developer (27K9A27SGR)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Nov 24, 2026 at 22:23:49
Info.plist=not bound
TeamIdentifier=27K9A27SGR
Runtime Version=15.5.0
`;
const adhoc = `Executable=/tmp/whisper-cli
Identifier=whisper-cli
Format=Mach-O thin (arm64)
CodeDirectory v=20400 size=62212 flags=0x20002(adhoc,linker-signed) hashes=1941+0 location=embedded
Signature=adhoc
Info.plist=not bound
TeamIdentifier=not set
`;

test('without a configured identity, local builds keep the previous ad-hoc signing', () => {
  assert.deepEqual(signingMode({}), {mode: 'adhoc'});
  assert.deepEqual(signingMode({DOTLINK_SIGNING_IDENTITY: '  '}), {mode: 'adhoc'});
  assert.deepEqual(codesignSteps(app, {mode: 'adhoc'}), [
    ['--force', '--sign', '-', `${bin}/node`],
    ['--force', '--sign', '-', `${bin}/tunnel-client`],
    ['--force', '--sign', '-', `${bin}/whisper-cli`],
    ['--force', '--sign', '-', '--identifier', 'app.tripsurf.dotlink.mac', app],
  ]);
});

test('Developer ID signing covers nested code inside-out with hardened runtime and timestamps', () => {
  const signing = signingMode({DOTLINK_SIGNING_IDENTITY: developerID.identity, DOTLINK_SIGNING_KEYCHAIN: developerID.keychain});
  assert.deepEqual(signing, developerID);
  const steps = codesignSteps(app, signing, '/src/node-runtime.entitlements');
  const targets = steps.map(args => args.at(-1));
  assert.deepEqual(targets, [
    `${bin}/node`, `${bin}/tunnel-client`, `${bin}/whisper-cli`,
    `${sparkle}/Versions/B/XPCServices/Installer.xpc`, `${sparkle}/Versions/B/XPCServices/Downloader.xpc`,
    `${sparkle}/Versions/B/Autoupdate`, `${sparkle}/Versions/B/Updater.app`, sparkle, app,
  ]);
  for (const args of steps) {
    assert.deepEqual(args.slice(0, 8), ['--force', '--sign', developerID.identity, '--options', 'runtime', '--timestamp', '--keychain', developerID.keychain]);
  }
  // Only node receives entitlements; Sparkle's Autoupdate application identifier is not carried over.
  assert.deepEqual(steps.filter(args => args.includes('--entitlements')).map(args => args.at(-1)), [`${bin}/node`]);
  assert.deepEqual(steps.filter(args => args.some(arg => arg.startsWith('--preserve-metadata'))).map(args => args.at(-1)), [`${sparkle}/Versions/B/XPCServices/Downloader.xpc`]);
  assert.deepEqual(steps.at(-1).slice(-3), ['--identifier', 'app.tripsurf.dotlink.mac', app]);
  assert.equal(codesignSteps(app, {mode: 'developer-id', identity: 'X'}, '/e')[0].includes('--keychain'), false);
  assert.throws(() => codesignSteps(app, signing), /entitlements are required/);
  assert.throws(() => codesignSteps(app, {mode: 'developer-id'}, '/e'), /Unknown signing mode/);
});

test('release signature check requires Developer ID, the team, hardened runtime and a secure timestamp', () => {
  assert.deepEqual(developerIDProblems(released, '27K9A27SGR'), []);
  assert.deepEqual(developerIDProblems(released, 'ABCDE12345'), ['team identifier is not ABCDE12345']);
  assert.deepEqual(developerIDProblems(adhoc, '27K9A27SGR'), [
    'not signed with a Developer ID Application certificate', 'team identifier is not 27K9A27SGR',
    'hardened runtime is not enabled', 'no secure timestamp',
  ]);
  assert.deepEqual(developerIDProblems(released.replace('flags=0x10000(runtime)', 'flags=0x0(none)'), '27K9A27SGR'), ['hardened runtime is not enabled']);
  assert.deepEqual(developerIDProblems(released.replace(/^Timestamp=.*\n/m, 'Signed Time=Nov 24, 2026\n'), '27K9A27SGR'), ['no secure timestamp']);
  assert.deepEqual(developerIDProblems(released.replace('Developer ID Application:', 'Apple Development:'), '27K9A27SGR'), ['not signed with a Developer ID Application certificate']);
});

test('the configured team and node entitlements are suitable for notarization', async () => {
  const config = JSON.parse(await readFile('config/mac-update.json', 'utf8'));
  assert.equal(developerTeam(config), '27K9A27SGR');
  assert.throws(() => developerTeam({}), /developerTeamID/);
  assert.throws(() => developerTeam({developerTeamID: 'short'}), /developerTeamID/);
  const entitlements = await readFile('native/DotLinkSetup/node-runtime.entitlements', 'utf8');
  assert.deepEqual([...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(match => match[1]), ['com.apple.security.cs.allow-jit']);
  assert.deepEqual(forbiddenEntitlements(entitlements), []);
  assert.deepEqual(forbiddenEntitlements('<key>com.apple.security.get-task-allow</key><true/>'), ['com.apple.security.get-task-allow']);
});

test('the Mach-O scan finds executables the signing plan would miss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dotlink-macho-'));
  try {
    const write = async (path, bytes) => { await mkdir(join(root, path, '..'), {recursive: true}); await writeFile(join(root, path), Buffer.from(bytes)); };
    await write('Contents/MacOS/DotLink', [0xcf, 0xfa, 0xed, 0xfe, 0, 0]);
    await write('Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle', [0xca, 0xfe, 0xba, 0xbe, 0, 0]);
    await write('Contents/Resources/payload/node_modules/pkg/addon.node', [0xcf, 0xfa, 0xed, 0xfe]);
    await write('Contents/Resources/payload/server/index.ts', [0x2f, 0x2f, 0x20, 0x78]);
    await write('Contents/Resources/short', [0xcf]);
    await symlink('Versions/B/Sparkle', join(root, 'Contents/Frameworks/Sparkle.framework/Sparkle'));
    const found = await findMachO(root);
    assert.deepEqual(found, ['Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle', 'Contents/MacOS/DotLink', 'Contents/Resources/payload/node_modules/pkg/addon.node']);
    assert.deepEqual(found.filter(path => !signedExecutables().includes(path)), ['Contents/Resources/payload/node_modules/pkg/addon.node']);
  } finally { await rm(root, {recursive: true, force: true}); }
});
