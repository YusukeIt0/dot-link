import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Read the running relay's containing app once, when its device service starts. */
export async function macClientVersion(info: URL): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)('/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', fileURLToPath(info)], { timeout: 2000 });
    const { CFBundleIdentifier, CFBundleShortVersionString: version, DotLinkBeta: beta } = JSON.parse(stdout);
    if (CFBundleIdentifier === 'app.tripsurf.dotlink.mac' && typeof version === 'string' &&
        /^\d+\.\d+\.\d+$/.test(version) && typeof beta === 'boolean')
      return beta ? `${version} Beta` : version;
  } catch { /* An unreadable version must not prevent pairing or conversation. */ }
}
