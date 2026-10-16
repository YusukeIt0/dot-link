import { execFileSync } from 'node:child_process';

export function evenBuild(version, mode, sourceCommit, dirty) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Even package version must be numeric');
  const channel = mode === 'release' ? 'release' : 'beta';
  return { version, channel, displayVersion: `${version}${channel === 'beta' ? ' Beta' : ''}`, sourceCommit, dirty };
}
export function sourceIdentity() {
  try {
    const options = {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']};
    return {
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], options).trim(),
      dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).trim(),
    };
  } catch {
    // Source archives can still build for development, but cannot produce a
    // falsely attributed physical-test package.
    return {sourceCommit: null, dirty: true};
  }
}
export function assertBetaBuild(build, version, source) {
  if (build.channel !== 'beta' || build.version !== version || build.displayVersion !== `${version} Beta`) throw new Error('Rebuild the current version in Beta mode before packaging');
  if (build.sourceCommit !== source.sourceCommit || build.dirty || source.dirty) throw new Error('Beta package requires a clean, matching source commit; commit changes and rebuild');
}
