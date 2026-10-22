import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('MCP metadata resolves the package relative to the server, not the working directory', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dot-metadata-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const moduleURL = new URL('../server/http.ts', import.meta.url).href;
  const script = `import { rpc } from ${JSON.stringify(moduleURL)};
    const responses = [];
    for (const method of ['server/discover', 'initialize']) {
      responses.push(await rpc(undefined, {jsonrpc:'2.0', id:1, method}));
    }
    console.log(JSON.stringify(responses));`;
  const responses = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' }));
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const response of responses) assert.deepEqual(response.result.serverInfo, { name: 'even-g2-dot', version });
  assert.deepEqual(responses[0].result.supportedVersions, ['2026-07-28']);
  assert.equal(responses[1].result.protocolVersion, '2025-11-25');
});
