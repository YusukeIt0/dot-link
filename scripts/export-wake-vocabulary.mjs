// Maintainer-only: derive the small ASCII tokenizer vocabulary from the pinned
// model archive, without installing SentencePiece in the app or build pipeline.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {wakeManifest} from './lib/wake-assets.mjs';
const archive = process.argv[2];
if (!archive) throw new Error('Usage: node scripts/export-wake-vocabulary.mjs <pinned-kws-archive>');
const bytes = await readFile(archive);
if (createHash('sha256').update(bytes).digest('hex') !== wakeManifest.downloads.kws.sha256) throw new Error('Unexpected model archive');
const entry = wakeManifest.files['tokens.txt'].entry.replace('tokens.txt', 'bpe.model');
const model = execFileSync('tar', ['-xOf', archive, entry], {maxBuffer: 2_000_000});
function fields(buf) {
  let i = 0; const result = [];
  function varint() { let n = 0n, shift = 0n; do { if (i >= buf.length || shift > 63n) throw new Error('Invalid protobuf'); const b = buf[i++]; n |= BigInt(b & 127) << shift; if (!(b & 128)) return Number(n); shift += 7n; } while (true); }
  while (i < buf.length) {
    const tag = varint(), wire = tag & 7; let value;
    if (wire === 0) value = varint();
    else { const size = wire === 2 ? varint() : wire === 5 ? 4 : wire === 1 ? 8 : -1; if (size < 0 || i + size > buf.length) throw new Error('Invalid field'); value = buf.subarray(i, i + size); i += size; }
    result.push({id: tag >>> 3, wire, value});
  }
  return result;
}
const all = fields(model);
const trainer = fields(all.find(f => f.id === 2).value);
// SentencePiece's file is named bpe.model, but this pinned vocabulary is UNIGRAM.
const modelType = trainer.find(f => f.id === 3)?.value ?? 1;
if (modelType !== 1) throw new Error('Expected unigram model');
const pieces = all.filter(f => f.id === 1).map(f => {
  const row = fields(f.value);
  return {piece: row.find(x => x.id === 1).value.toString('utf8'), score: row.find(x => x.id === 2).value.readFloatLE(), type: row.find(x => x.id === 3)?.value ?? 1};
}).filter(p => p.type === 1 && /^[A-Z▁]+$/.test(p.piece)).map(p => [p.piece, p.score]);
const output = JSON.stringify({modelSha256:createHash('sha256').update(model).digest('hex'), algorithm:'sentencepiece-unigram-ascii', pieces}) + '\n';
await writeFile('distribution/wake/name-vocabulary.json', output);
console.log(`Exported ${pieces.length} ASCII pieces (${Buffer.byteLength(output)} bytes).`);
