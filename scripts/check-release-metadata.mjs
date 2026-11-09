import assert from 'node:assert/strict';
import {createPublicKey, verify, createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {macPlist, macFeed, plist, versionOnly} from './ci-plan.mjs';

export function verifySignature(bytes, signature, publicKey) {
  assert.match(signature, /^[A-Za-z0-9+/]{86}==$/);
  const raw = Buffer.from(publicKey, 'base64');
  assert.equal(raw.length, 32);
  const key = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki'});
  assert.ok(verify(null, bytes, key, Buffer.from(signature, 'base64')), 'Invalid Ed25519 signature');
}

export function parseFeed(bytes, publicKey) {
  assert.ok(bytes.length < 100_000, 'Feed exceeds size bound');
  const tail = bytes.toString('utf8').match(/<!-- sparkle-signatures:\s*edSignature: (\S+)\s*length: (\d+)\s*-->\s*$/);
  assert.ok(tail, 'Missing signed-feed trailer');
  const length = Number(tail[2]);
  assert.equal(Buffer.byteLength(bytes.toString('utf8').slice(0, tail.index)), length, 'Unsigned content before trailer');
  verifySignature(bytes.subarray(0, length), tail[1], publicKey);
  // Standard XML parser, with entities/DTDs rejected and the exact supported schema.
  const script = String.raw`
import json,sys,xml.etree.ElementTree as E
b=sys.stdin.buffer.read()
assert b'<!DOCTYPE' not in b.upper() and b'<!ENTITY' not in b.upper()
r=E.fromstring(b); ns='{http://www.andymatuschak.org/xml-namespaces/sparkle}'
assert r.tag=='rss' and r.attrib=={'version':'2.0'} and [x.tag for x in r]==['channel']
c=r[0]; assert not c.attrib and [x.tag for x in c]==['title','item'] and c[0].text=='Dot Link for Mac'
i=c[1]; assert not i.attrib
assert [x.tag for x in i]==['title',ns+'version',ns+'shortVersionString',ns+'minimumSystemVersion','description','enclosure']
for x in [c[0],*i]: assert len(x)==0
for x in list(i)[:4]: assert not x.attrib
assert i[4].attrib=={ns+'format':'plain-text'}
e=i[5]; assert set(e.attrib)=={'url',ns+'installationType',ns+'edSignature','length','type'}
assert e.get(ns+'installationType')=='application' and e.get('type')=='application/octet-stream'
print(json.dumps(dict(title=i[0].text,build=i[1].text,version=i[2].text,minimumOS=i[3].text,notes=i[4].text,url=e.get('url'),signature=e.get(ns+'edSignature'),length=e.get('length'))))
`;
  return JSON.parse(execFileSync('python3', ['-c', script], {input: bytes.subarray(0, length), encoding: 'utf8', maxBuffer: 150_000, stdio: ['pipe', 'pipe', 'pipe']}));
}

export function checkFeedIdentity(feed, app, config, release) {
  assert.equal(feed.build, app.CFBundleVersion);
  assert.equal(feed.version, app.CFBundleShortVersionString);
  assert.equal(feed.minimumOS, app.LSMinimumSystemVersion);
  assert.equal(feed.title, `Dot Link ${feed.version}`);
  assert.match(feed.build, /^[1-9]\d{0,8}$/);
  assert.match(feed.version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  assert.ok(feed.notes?.trim(), 'Release notes are required');
  const tag = `mac-v${feed.version}-${feed.build}`, name = `Dot-Link-${feed.version}-${feed.build}-arm64.zip`;
  assert.equal(feed.url, `https://github.com/${config.downloadRepository || config.repository}/releases/download/${tag}/${name}`);
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.equal((release.body || '').trim(), feed.notes.trim(), 'Public release notes differ');
  const assets = release.assets.filter(a => a.name === name);
  assert.equal(assets.length, 1);
  const asset = assets[0];
  assert.match(feed.length, /^[1-9]\d{0,9}$/);
  assert.equal(Number(feed.length), asset.size);
  assert.ok(asset.size <= 256 * 1024 * 1024, 'Archive exceeds size bound');
  assert.match(asset.digest || '', /^sha256:[a-f0-9]{64}$/);
  return asset;
}

async function fetchBytes(url, limit) {
  const response = await fetch(url, {signal: AbortSignal.timeout(60_000)});
  assert.ok(response.ok, `Public release request failed (${response.status})`);
  assert.equal(new URL(response.url).protocol, 'https:');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= limit, 'Public response exceeds size bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function checkArtifact(bytes, feed, asset, publicKey) {
  assert.equal(bytes.length, asset.size);
  assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, asset.digest);
  verifySignature(bytes, feed.signature, publicKey);
}

export async function checkRelease(kind, base) {
  const text = readFileSync(macPlist, 'utf8'), app = plist(text);
  assert.equal(app.CFBundleIdentifier, 'app.tripsurf.dotlink.mac');
  assert.equal(app.DotLinkBeta, false);
  assert.match(app.LSMinimumSystemVersion, /^\d+\.\d+(?:\.\d+)?$/);
  if (kind === 'version') {
    assert.ok(versionOnly(execFileSync('git', ['show', `${base}:${macPlist}`], {encoding: 'utf8'}), text), 'Version-only invariants failed');
    return;
  }
  const config = JSON.parse(readFileSync('config/mac-update.json', 'utf8'));
  assert.equal(config.repository, 'YusukeIt0/dot-link');
  const feed = parseFeed(readFileSync(macFeed), config.publicKey);
  // Validate before interpolating into any network request.
  assert.match(feed.version, /^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
  assert.match(feed.build, /^[1-9]\d{0,8}$/);
  const tag = `mac-v${feed.version}-${feed.build}`;
  const release = JSON.parse((await fetchBytes(`https://api.github.com/repos/${config.repository}/releases/tags/${tag}`, 2_000_000)).toString());
  const asset = checkFeedIdentity(feed, app, config, release);
  checkArtifact(await fetchBytes(feed.url, asset.size), feed, asset, config.publicKey);
  console.log('Committed feed, public release notes, archive digest/length and both signatures verified.');
}
