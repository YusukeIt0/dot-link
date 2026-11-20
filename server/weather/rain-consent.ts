import {closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {SATELLITE_TERMS, WEATHER_TERMS} from '../../src/weather-terms.ts';

export {SATELLITE_TERMS};
const ownerId = /^[0-9a-f]{64}$/;

// The pin keeps its inode allocated even across a downgrade and re-enrollment.
function grantIdentity(path: string, owner: string) {
  if (!ownerId.test(owner)) return;
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(file, {bigint: true});
    if (!info.isFile() || info.size > 4096n) return;
    const bytes = Buffer.alloc(Number(info.size));
    if (readSync(file, bytes, 0, bytes.length, 0) !== bytes.length) return;
    const state = JSON.parse(bytes.toString('utf8'));
    if (state?.version === 1 && state.enabled === true && state.owner === owner && state.terms === WEATHER_TERMS && Object.keys(state).length === 4)
      return `${info.dev}-${info.ino}`;
  } finally {closeSync(file);}
}

function parseMarker(name: string) {
  const [terms, identity, value, ...rest] = name.split('.');
  const since = Number(value);
  if (!rest.length && terms === SATELLITE_TERMS && /^\d+-\d+$/.test(identity) &&
      Number.isSafeInteger(since) && since >= 0 && String(since) === value) return {identity, since};
}

/** Pin the strict v1 grant itself. Old and new relays atomically replace it on
 * every consent write. One hard link commits the generation and its intake time. */
export class RainConsent {
  private readonly path: string;
  private readonly directory: string;
  constructor(weatherConsentPath: string) {
    this.path = weatherConsentPath;
    this.directory = weatherConsentPath + '.satellite-consent';
  }

  // Normal state has zero or one entry. Treat malformed state as unavailable.
  private marker() {
    if (!lstatSync(this.directory).isDirectory()) throw Error('Invalid satellite consent directory');
    const directory = opendirSync(this.directory);
    try {
      const entry = directory.readSync();
      if (!entry) return;
      const parsed = parseMarker(entry.name);
      if (!parsed || !entry.isFile() || directory.readSync()) throw Error('Invalid satellite consent');
      return {...parsed, path: join(this.directory, entry.name)};
    } finally {directory.closeSync();}
  }

  since(owner: string): number | undefined {
    try {
      const marker = this.marker();
      if (!marker || marker.identity !== grantIdentity(this.path, owner)) return;
      const pin = lstatSync(marker.path, {bigint: true});
      if (pin.isFile() && marker.identity === `${pin.dev}-${pin.ino}`) return marker.since;
    } catch { /* Missing, unreadable or stale consent authorizes no supplemental use. */ }
  }

  /** Prior to the MET file's atomic rename, only the staged generation is
   * pinned. Its authorization becomes readable when that generation is current. */
  grant(owner: string, since: number, source = this.path): boolean {
    if (!Number.isSafeInteger(since) || since < 0) return false;
    try {
      const identity = grantIdentity(source, owner);
      if (!identity) return false;
      try {mkdirSync(this.directory, {mode: 0o700});} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      const prior = this.marker();
      if (prior) unlinkSync(prior.path);
      const marker = join(this.directory, `${SATELLITE_TERMS}.${identity}.${since}`);
      linkSync(source, marker);
      const pin = lstatSync(marker, {bigint: true});
      return pin.isFile() && identity === `${pin.dev}-${pin.ino}`;
    } catch {return false;}
  }

  clear() {
    try {
      const marker = this.marker();
      if (marker) unlinkSync(marker.path);
    } catch { /* Replacement or removal of the MET grant already fences every old pin. */ }
  }
}
