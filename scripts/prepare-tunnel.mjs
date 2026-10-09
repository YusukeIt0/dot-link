import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const id = process.argv[2];
if (!/^tunnel_[a-zA-Z0-9_-]{16,128}$/.test(id ?? '')) throw new Error('Pass the tunnel ID shown by OpenAI Platform');
const key = (await readFile('.runtime/mcp-key', 'utf8')).trim();
if (key.length < 32) throw new Error('Run bridge:init first');
const runtime = (await readFile('.runtime/tunnel-api-key', 'utf8')).trim();
if (!/^sk-[A-Za-z0-9_-]{20,1000}$/.test(runtime)) throw new Error('Save the runtime API key first');
await writeFile('.runtime/mcp-authorization-header', `Bearer ${key}`, { mode: 0o600 });
const config = {
  config_version: 1,
  control_plane: {
    base_url: 'https://api.openai.com', tunnel_id: id,
    api_key: `file:${resolve('.runtime/tunnel-api-key')}`,
  },
  mcp: {
    server_urls: [{ channel: 'main', url: 'http://127.0.0.1:3460/mcp' }],
    extra_headers: { Authorization: `file:${resolve('.runtime/mcp-authorization-header')}` },
    startup_wait_timeout: '10s',
  },
  health: { listen_addr: '127.0.0.1:3461', url_file: resolve('.runtime/tunnel-health-url') },
  admin_ui: { open_browser: false },
  process: { pid_file: resolve('.runtime/tunnel.pid') },
  log: { level: 'info', format: 'json', file: resolve('.runtime/tunnel.log') },
};
// JSON is a YAML subset accepted by the tunnel-client YAML loader.
await writeFile('.runtime/tunnel.yaml', JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('Tunnel profile prepared with file references. No secret values were printed.');
