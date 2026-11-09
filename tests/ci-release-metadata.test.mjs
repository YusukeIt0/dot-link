import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign, createHash} from 'node:crypto';
import {macAppcast} from '../scripts/lib/mac-appcast.mjs';
import {parseFeed, checkFeedIdentity, checkArtifact} from '../scripts/check-release-metadata.mjs';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const rawKey = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64');
const artifact = Buffer.from('synthetic archive bytes');
const signature = bytes => sign(null, bytes, privateKey).toString('base64');
const tag = 'mac-v1.2.3-100', name = 'Dot-Link-1.2.3-100-arm64.zip';
const xml = macAppcast({version: '1.2.3', build: '100', minimumSystemVersion: '13.5', notes: '- Example change.\n',
  downloadRepository: 'YusukeIt0/dot-link-app', tag, name, signature: signature(artifact), size: artifact.length});
const signed = text => Buffer.from(`${text}<!-- sparkle-signatures:\nedSignature: ${signature(Buffer.from(text))}\nlength: ${Buffer.byteLength(text)}\n-->\n`);
const app = {CFBundleVersion: '100', CFBundleShortVersionString: '1.2.3', LSMinimumSystemVersion: '13.5'};
const config = {repository: 'YusukeIt0/dot-link', downloadRepository: 'YusukeIt0/dot-link-app'};
const asset = {name, size: artifact.length, digest: `sha256:${createHash('sha256').update(artifact).digest('hex')}`};
const release = {tag_name: tag, draft: false, prerelease: false, body: '- Example change.', assets: [asset]};

test('signed committed feed and archive are independently verified with only a public key', () => {
  const feed = parseFeed(signed(xml), rawKey);
  assert.deepEqual(checkFeedIdentity(feed, app, config, release), asset);
  checkArtifact(artifact, feed, asset, rawKey);
});

test('tampering, unsigned trailing XML, invalid schema and unrecognized XML fields fail', () => {
  const valid = signed(xml);
  assert.throws(() => parseFeed(Buffer.from(valid.toString().replace('Example', 'Tampered')), rawKey));
  assert.throws(() => parseFeed(Buffer.concat([valid, Buffer.from('<item/>')]), rawKey));
  assert.throws(() => parseFeed(Buffer.from(valid.toString().replace('<!-- sparkle-signatures:', '<!-- unsigned -->\n<!-- sparkle-signatures:')), rawKey));
  for (const text of [xml.replace('</item>', '<sparkle:criticalUpdate/></item>'),
    xml.replace('<rss ', '<!DOCTYPE rss><rss '), xml.replace('installationType="application"', 'installationType="package"'),
    xml.replace('</channel>', '<item/></channel>')]) assert.throws(() => parseFeed(signed(text), rawKey));
});

test('identity, notes, release status, length, hash and archive signatures are required', () => {
  const feed = parseFeed(signed(xml), rawKey);
  for (const delta of [{build: '101'}, {version: '1.2.4'}, {minimumOS: '14.0'}, {notes: ''}, {title: 'Wrong'},
    {url: 'https://example.com/a.zip'}, {length: '999'}, {length: '0'+artifact.length}]) {
    assert.throws(() => checkFeedIdentity({...feed, ...delta}, app, config, release));
  }
  for (const delta of [{draft: true}, {prerelease: true}, {tag_name: 'other'}, {body: '- Other notes.'},
    {assets: []}, {assets: [asset, asset]}, {assets: [{...asset, digest: null}]}]) {
    assert.throws(() => checkFeedIdentity(feed, app, config, {...release, ...delta}));
  }
  assert.throws(() => checkArtifact(Buffer.from('changed'), feed, asset, rawKey));
  assert.throws(() => checkArtifact(artifact, feed, {...asset, digest: 'sha256:'+'0'.repeat(64)}, rawKey));
  assert.throws(() => checkArtifact(artifact, {...feed, signature: signature(Buffer.from('other'))}, asset, rawKey));
});
