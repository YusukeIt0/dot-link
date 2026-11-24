// Code signing plan for the Mac app bundle.
// Developer ID mode needs the maintainer's identity in an unlocked keychain.
// Without DOTLINK_SIGNING_IDENTITY, local builds keep the previous ad-hoc
// signatures; the release helper refuses those builds.
import {open, readdir} from 'node:fs/promises';
import {join, relative} from 'node:path';

export const bundleIdentifier = 'app.tripsurf.dotlink.mac';
export const runtimeBinaries = ['node', 'tunnel-client', 'whisper-cli'];
// Sparkle's documented inside-out order for Developer ID with hardened runtime.
const sparkleParts = [
  ['Versions/B/XPCServices/Installer.xpc', []],
  ['Versions/B/XPCServices/Downloader.xpc', ['--preserve-metadata=entitlements']],
  ['Versions/B/Autoupdate', []],
  ['Versions/B/Updater.app', []],
  ['', []],
];

export function developerTeam(config) {
  const team = config.developerTeamID;
  if (!/^[A-Z0-9]{10}$/.test(team ?? '')) throw new Error('config/mac-update.json needs a 10-character developerTeamID');
  return team;
}

export function signingMode(env) {
  const identity = env.DOTLINK_SIGNING_IDENTITY?.trim();
  if (!identity) return {mode: 'adhoc'};
  const keychain = env.DOTLINK_SIGNING_KEYCHAIN?.trim() || undefined;
  return {mode: 'developer-id', identity, keychain};
}

function paths(app) {
  const bin = join(app, 'Contents/Resources/payload/.runtime/bin');
  const sparkle = join(app, 'Contents/Frameworks/Sparkle.framework');
  return {bin, sparkle};
}

// Returns codesign argument lists in the order they must run.
export function codesignSteps(app, signing, nodeEntitlements) {
  const {bin, sparkle} = paths(app);
  if (signing.mode === 'adhoc') return [
    ...runtimeBinaries.map(name => ['--force', '--sign', '-', join(bin, name)]),
    ['--force', '--sign', '-', '--identifier', bundleIdentifier, app],
  ];
  if (signing.mode !== 'developer-id' || !signing.identity) throw new Error('Unknown signing mode');
  if (!nodeEntitlements) throw new Error('Node entitlements are required for hardened runtime');
  const base = ['--force', '--sign', signing.identity, '--options', 'runtime', '--timestamp',
    ...(signing.keychain ? ['--keychain', signing.keychain] : [])];
  return [
    [...base, '--entitlements', nodeEntitlements, join(bin, 'node')],
    ...runtimeBinaries.filter(name => name !== 'node').map(name => [...base, join(bin, name)]),
    ...sparkleParts.map(([part, extra]) => [...base, ...extra, part ? join(sparkle, part) : sparkle]),
    [...base, '--identifier', bundleIdentifier, app],
  ];
}

// Every Mach-O file the signing plan covers, as bundle-relative paths.
export function signedExecutables() {
  return [
    'Contents/MacOS/DotLink',
    ...runtimeBinaries.map(name => `Contents/Resources/payload/.runtime/bin/${name}`),
    'Contents/Frameworks/Sparkle.framework/Versions/B/Sparkle',
    'Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate',
    'Contents/Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater',
    'Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Installer.xpc/Contents/MacOS/Installer',
    'Contents/Frameworks/Sparkle.framework/Versions/B/XPCServices/Downloader.xpc/Contents/MacOS/Downloader',
  ];
}

const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

// Lists regular files with a Mach-O header. Symlinks are not followed.
export async function findMachO(root, directory = root) {
  const found = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await findMachO(root, path));
    else if (entry.isFile()) {
      const file = await open(path, 'r');
      try {
        const {bytesRead, buffer} = await file.read(Buffer.alloc(4), 0, 4, 0);
        if (bytesRead === 4 && machOMagic.has(buffer.readUInt32BE(0))) found.push(relative(root, path));
      } finally { await file.close(); }
    }
  }
  return found.sort();
}

// Checks `codesign -dvv` output (written to stderr) for a release signature.
export function developerIDProblems(display, team) {
  const problems = [];
  if (!display.includes('\nAuthority=Developer ID Application: ') && !display.startsWith('Authority=Developer ID Application: ')) problems.push('not signed with a Developer ID Application certificate');
  if (!new RegExp(`^TeamIdentifier=${team}$`, 'm').test(display)) problems.push(`team identifier is not ${team}`);
  if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(display)) problems.push('hardened runtime is not enabled');
  if (!/^Timestamp=/m.test(display)) problems.push('no secure timestamp');
  return problems;
}

// Entitlements a release executable must never carry.
export function forbiddenEntitlements(entitlements) {
  return ['com.apple.security.get-task-allow'].filter(key => entitlements.includes(`<key>${key}</key>`));
}
