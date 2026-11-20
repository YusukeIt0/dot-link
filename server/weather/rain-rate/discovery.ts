import {crc32} from 'node:zlib';

const HOST = 'https://noaa-enterprise-rainrate-pds.s3.us-east-1.amazonaws.com/';
const ROOT = 'BLEND/RainRate-Blend-INST/';
const AGENT = 'DotLink/WeatherContext (+https://github.com/YusukeIt0/dot-link)';
const HOUR = 3_600_000;
export const FRAME_AGE = 45 * 60_000;
export const OBJECT_LIMIT = 8 * 1024 * 1024;
export const LIST_LIMIT = 64 * 1024;

export interface RainRateFrame {
  key: string; inputs: number; start: number; end: number; created: number; published: number; etag: string; size: number;
}
type Reserve = (maximum: number) => void;
const keyPattern = /^BLEND\/RainRate-Blend-INST\/(\d{4}\/\d{2}\/\d{2}\/\d{2})\/RRQPE-INST-GLB-([1-5])_v1r1_blend_s(\d{15})_e(\d{15})_c(\d{15})\.nc$/;
const etagPattern = /^"[0-9a-f]{32}(?:-[1-9]\d{0,4})?"$/;
function hourPrefix(time: number) {
  const iso = new Date(time).toISOString();
  return ROOT + [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10), iso.slice(11, 13)].join('/') + '/';
}
function instant(t: string) {
  const iso = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}.${t[14]}00Z`;
  const value = Date.parse(iso);
  return Number.isFinite(value) && new Date(value).toISOString() === iso ? value : NaN;
}
export function frameFromKey(key: string, etag: string, size: number, published: number): RainRateFrame | undefined {
  const match = keyPattern.exec(key);
  if (!match || !etagPattern.test(etag) || !Number.isSafeInteger(size) || size < 8 || size > OBJECT_LIMIT || !Number.isSafeInteger(published)) return;
  const [, , n, s, e, c] = match;
  const start = instant(s), end = instant(e), created = instant(c);
  if (![start, end, created].every(Number.isFinite) || start % 600_000 || end !== start + 599_900 ||
    !key.startsWith(hourPrefix(start)) || created < end || published < Math.floor(created / 1000) * 1000) return;
  return {key, inputs: Number(n), start, end, created, published, size, etag};
}
export function freshFrame(frame: RainRateFrame, now: number) {
  // Producer coverage_end is minute precision, earlier than the filename's end.
  return frame.published <= now && frame.created <= now && frame.end <= now && now - Math.floor(frame.end / 60_000) * 60_000 <= FRAME_AGE;
}
function field(xml: string, name: string): string {
  const tag = new RegExp('<' + name + '>([^<>]*)</' + name + '>', 'g');
  const matches = [...xml.matchAll(tag)];
  return matches.length === 1 ? matches[0][1] : '';
}
export function parseListing(xml: string, prefix: string, now: number): RainRateFrame[] {
  if (Buffer.byteLength(xml) > LIST_LIMIT || /<!|<\?[^x]/i.test(xml) ||
    !/^\s*(?:<\?xml[^?]*\?>\s*)?<ListBucketResult xmlns="http:\/\/s3.amazonaws.com\/doc\/2006-03-01\/">/.test(xml) ||
    !xml.trimEnd().endsWith('</ListBucketResult>') || field(xml, 'Name') !== 'noaa-enterprise-rainrate-pds' ||
    field(xml, 'Prefix') !== prefix || field(xml, 'IsTruncated') !== 'false') throw Error('Unexpected NOAA listing');
  const rows = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)];
  if (rows.length > 64 || field(xml, 'KeyCount') !== String(rows.length)) throw Error('Incomplete NOAA listing');
  const frames: RainRateFrame[] = [];
  for (const [, row] of rows) {
    const key = field(row, 'Key');
    if (!key.startsWith(prefix) || field(row, 'ChecksumAlgorithm') !== 'CRC32' || field(row, 'ChecksumType') !== 'FULL_OBJECT') continue;
    const stamp = field(row, 'LastModified');
    const published = Date.parse(stamp);
    if (!Number.isFinite(published) || new Date(published).toISOString() !== stamp) continue;
    const frame = frameFromKey(key, field(row, 'ETag').replaceAll('&quot;', '"'), Number(field(row, 'Size')), published);
    if (frame && freshFrame(frame, now)) frames.push(frame);
  }
  return frames;
}
function compare(a: RainRateFrame, b: RainRateFrame) {
  return b.start - a.start || b.inputs - a.inputs || b.created - a.created || b.published - a.published;
}
export function chooseEdition(frames: RainRateFrame[]) {
  const sorted = [...frames].sort(compare);
  if (!sorted.length) return;
  // Early mosaics can omit an entire satellite footprint. Prefer a complete
  // edition at most one cadence behind; later sparse windows still progress.
  return sorted.find(f => f.inputs === 5 && f.start >= sorted[0].start - 600_000) ?? sorted[0];
}
async function body(response: Response, maximum: number, exact: number | undefined, signal: AbortSignal) {
  const declared = response.headers.get('content-length');
  if (!response.body || response.status !== 200 || response.headers.has('content-range') ||
    (response.headers.get('content-encoding') ?? 'identity') !== 'identity' ||
    (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) ||
    (exact !== undefined && (declared === null || Number(declared) !== exact))) {
    await response.body?.cancel(); throw Error('Unexpected NOAA response');
  }
  const reader = response.body.getReader();
  const output = Buffer.allocUnsafe(maximum); let length = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', abort, {once: true});
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maximum) throw Error('NOAA body exceeds budget');
      output.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    signal.throwIfAborted();
    if (declared !== null && length !== Number(declared)) throw Error('Incomplete NOAA response');
    return output.subarray(0, length);
  } finally {signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
}
export async function discoverFrames(now: number, request: typeof fetch, reserve: Reserve, signal: AbortSignal) {
  const hour = Math.floor(now / HOUR) * HOUR;
  const hours = now - hour < FRAME_AGE + 60_000 ? [hour, hour - HOUR] : [hour];
  const frames: RainRateFrame[] = [];
  for (const h of hours) {
    signal.throwIfAborted();
    const prefix = hourPrefix(h);
    const url = new URL(HOST);
    url.search = new URLSearchParams({'list-type': '2', prefix, 'max-keys': '64'}).toString();
    reserve(LIST_LIMIT);
    const response = await request(url, {headers: {'User-Agent': AGENT, 'Accept-Encoding': 'identity'}, redirect: 'error', signal});
    frames.push(...parseListing((await body(response, LIST_LIMIT, undefined, signal)).toString('utf8'), prefix, now));
  }
  return frames;
}
export async function acquireFrame(frame: RainRateFrame, request: typeof fetch, reserve: Reserve, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!frameFromKey(frame.key, frame.etag, frame.size, frame.published)) throw Error('Invalid NOAA frame');
  reserve(frame.size);
  const response = await request(new URL(frame.key, HOST), {
    headers: {
      'User-Agent': AGENT, 'Accept-Encoding': 'identity',
      'If-Match': frame.etag, 'x-amz-checksum-mode': 'ENABLED'
    }, redirect: 'error', signal
  });
  const checksum = response.headers.get('x-amz-checksum-crc32');
  if (response.headers.get('etag') !== frame.etag || response.headers.get('x-amz-checksum-type') !== 'FULL_OBJECT' ||
    !checksum || !/^[A-Za-z0-9+/]{6}==$/.test(checksum) || Buffer.from(checksum, 'base64').toString('base64') !== checksum ||
    Date.parse(response.headers.get('last-modified') ?? '') !== frame.published) {
    await response.body?.cancel(); throw Error('Unverified NOAA object');
  }
  const bytes = await body(response, frame.size, frame.size, signal);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 72, 68, 70, 13, 10, 26, 10])) || crc32(bytes) !== Buffer.from(checksum, 'base64').readUInt32BE()) {
    throw Error('Invalid NOAA payload');
  }
  return {bytes, checksum};
}
