import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../scripts/lib/setup.mjs';
import { setupFailure, setupError, setupStage, readSetupFailure, runSetupInstall, activateRelay, saveSetupFailure, clearSetupFailure } from '../scripts/lib/setup-failure.mjs';
import catalog from '../scripts/lib/setup-errors.json' with { type: 'json' };

const secret = 'sk-test-secret-never-display';
const fail = (code, stage) => ({ version: 1, code, stage });
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'dot-link-setup-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Execute the real CLI with only its OS/service dependencies replaced. No
// Tailscale, LaunchAgent, keychain, installed app or real user state is touched.
async function installFixture(t, scenario) {
  const root = await temporary(t), scripts = join(root, 'scripts');
  await mkdir(join(scripts, 'lib'), { recursive: true });
  for (const name of ['setup-failure.mjs', 'setup-errors.json']) {
    await writeFile(join(scripts, 'lib', name), await readFile(new URL(`../scripts/lib/${name}`, import.meta.url)));
  }
  await writeFile(join(scripts, 'setup.mjs'), await readFile(new URL('../scripts/setup.mjs', import.meta.url)));
  const stub = `
    import { setupError } from './setup-failure.mjs';
    const scenario = ${JSON.stringify(scenario)};
    const raw = () => Object.assign(new Error(${JSON.stringify(secret)}), {code: 7, stdout: ${JSON.stringify(secret)}, stderr: ${JSON.stringify(secret)}});
    export const assertOwnedAgents = async () => { if(scenario==='ownership') throw setupError('EXISTING_SERVICE_CONFLICT'); };
    export const tailscale = async () => {
      if(scenario==='login') throw setupError('TAILSCALE_LOGIN_REQUIRED');
      return {bin:'/fake/tailscale',origin:'https://private-host.ts.net',state:scenario==='conflict'?'conflict':scenario==='funnel'?'public':'missing'};
    };
    export const executable = async () => scenario==='client' ? undefined : '/fake/client';
    export const run = async (_, args) => { if(scenario==='init' || (scenario==='pair' && args[0]==='scripts/pair-device.mjs')) throw raw(); return ''; };
    export const runTailscale = async () => {
      if(scenario.startsWith('approval-')) throw Object.assign(raw(), {
        [scenario.includes('stderr') ? 'stderr' : 'stdout']: 'Enable Serve: https://login.tailscale.com/f/serve?node=private-host&token=' + ${JSON.stringify(secret)},
        ...(scenario.endsWith('timeout') ? {code:null, killed:true, signal:'SIGTERM'} : {})
      });
      if(scenario==='https') throw raw();
      if(scenario==='timeout') throw Object.assign(raw(), {code:null, killed:true, signal:'SIGTERM'});
      return '';
    };
    export const prepareAgents = async () => {
      if(scenario==='services') throw setupError('SERVICE_REGISTRATION_FAILED', 'safe text', raw());
      if(scenario==='permission') throw Object.assign(raw(), {code:'EACCES'});
      return ['bridge','device','tunnel'];
    };
  `;
  await writeFile(join(scripts, 'lib/setup.mjs'), stub);
  await mkdir(join(root, '.runtime/models'), { recursive: true });
  await mkdir(join(root, 'dist'));
  for (const file of ['.runtime/tunnel.yaml', '.runtime/models/ggml-small.bin', 'dist/index.html']) {
    if (scenario === 'missing' && file === '.runtime/tunnel.yaml') continue;
    if (scenario === 'model' && file === '.runtime/models/ggml-small.bin') continue;
    await writeFile(join(root, file), secret);
  }
  const legacyApp = join(root, '.runtime/notification-menu/Dot Notification Lab.app/Contents/MacOS');
  await mkdir(legacyApp, { recursive: true });
  await writeFile(join(legacyApp, 'DotNotificationLab'), 'fixture');
  return { root, execute: (voiceOnly = true) => run(process.execPath, [join(scripts, 'setup.mjs'), 'install', ...(voiceOnly ? ['--voice-only'] : []), '--directory', root]) };
}

test('real setup install failures survive nonzero exit through the activation parent without raw output', async t => {
  const scenarios = [
    ['ownership','EXISTING_SERVICE_CONFLICT','ownership'],
    ['login','TAILSCALE_LOGIN_REQUIRED','tailscale'],
    ['conflict','TAILSCALE_SERVE_CONFLICT','tailscale'],
    ['funnel','TAILSCALE_FUNNEL_ENABLED','tailscale'],
    ['missing','TUNNEL_CONFIG_MISSING','prerequisites'],
    ['model','SPEECH_MODEL_MISSING','prerequisites'],
    ['client','TUNNEL_CLIENT_MISSING','prerequisites'],
    ['init','SETUP_COMMAND_FAILED','initialize'],
    ['https','TAILSCALE_HTTPS_FAILED','https'],
    ['timeout','SETUP_TIMEOUT','https'],
    ['approval-stdout','TAILSCALE_SERVE_APPROVAL_REQUIRED','https'],
    ['approval-stderr','TAILSCALE_SERVE_APPROVAL_REQUIRED','https'],
    ['approval-stdout-timeout','TAILSCALE_SERVE_APPROVAL_REQUIRED','https'],
    ['approval-stderr-timeout','TAILSCALE_SERVE_APPROVAL_REQUIRED','https'],
    ['services','SERVICE_REGISTRATION_FAILED','services'],
    ['permission','SETUP_PERMISSION_DENIED','services'],
  ];
  for (const [scenario,code,stage] of scenarios) {
    const f = await installFixture(t, scenario);
    await assert.rejects(runSetupInstall(f.execute), error => {
      const failure = setupFailure(error);
      assert.equal(failure.code, code, scenario); assert.equal(failure.stage, stage, scenario);
      assert.doesNotMatch(JSON.stringify(failure), /sk-test|private-host|\/fake/);
      return true;
    });
    await assert.rejects(f.execute(), error => {
      assert.doesNotMatch(error.stdout, /sk-test|private-host|\/fake/);
      assert.equal(JSON.parse(error.stdout).ready, false);
      return true;
    });
  }
});

test('successful install still returns changes and an empty change list is valid', async t => {
  const f = await installFixture(t, 'success');
  assert.deepEqual((await runSetupInstall(f.execute)).changed, ['bridge','device','tunnel']);
  assert.deepEqual(await runSetupInstall(async () => '{"changed":[]}'), { changed: [] });
});

test('Serve approval output is interpreted only at the HTTPS Serve stage', () => {
  const error = { code: null, killed: true, signal: 'SIGTERM', stderr: 'https://login.tailscale.com/f/serve?node=private-host' };
  assert.equal(setupFailure(error, 'install').code, 'SETUP_TIMEOUT');
  assert.equal(setupFailure(error, 'tailscale', 'TAILSCALE_STATUS_FAILED').code, 'SETUP_TIMEOUT');
  const failure = setupFailure(error, 'https', 'TAILSCALE_HTTPS_FAILED');
  assert.equal(failure.code, 'TAILSCALE_SERVE_APPROVAL_REQUIRED');
  assert.equal(failure.signal, 'SIGTERM');
  assert.doesNotMatch(JSON.stringify(failure), /login\.tailscale|private-host/);
});

test('malformed, legacy, success-looking failed children and timed out children never look successful', async () => {
  for (const output of ['not json', '{}', '{"changed":true}', '{"ready":false}', '{"changed":["secret"]}']) {
    await assert.rejects(setupStage('install', () => runSetupInstall(async () => output)), e => e.failure.code === 'SETUP_INVALID_RESPONSE');
  }
  for (const stdout of [JSON.stringify({ready:false,issues:[secret]}), '{"changed":[]}', secret]) {
    await assert.rejects(runSetupInstall(async () => { throw Object.assign(new Error(secret), {code:1,stdout}); }), e => {
      assert.deepEqual(e.failure, {...fail('SETUP_COMMAND_FAILED','install'),exitCode:1});
      return true;
    });
  }
  await assert.rejects(runSetupInstall(() => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 80 })), e => e.failure.code === 'SETUP_TIMEOUT' && e.failure.stage === 'install');
  // Ignore an incomplete child's claimed failure when the process was killed.
  await assert.rejects(runSetupInstall(async () => { throw {killed:true,signal:'SIGTERM',stdout:JSON.stringify({ready:false,failure:fail('TAILSCALE_LOGIN_REQUIRED','tailscale')})}; }), e => e.failure.code === 'SETUP_TIMEOUT');
});

test('each post-install failure stops activation at its stage and preserves an existing code', async () => {
  const stages = ['install','app-install','app-register','runtime-prepare','runtime-finish','health'];
  for (const [index,stage] of stages.entries()) {
    const calls = [];
    const operations = Object.fromEntries(stages.map(s => [s, async () => {
      calls.push(s);
      if(s===stage) throw Object.assign(new Error(secret), {code:'EACCES'});
      return {bridge:true};
    }]));
    await assert.rejects(activateRelay(operations), error => {
      assert.deepEqual(error.failure, fail('SETUP_PERMISSION_DENIED',stage)); return true;
    });
    assert.deepEqual(calls,stages.slice(0,index+1));
  }
  await assert.rejects(setupStage('runtime-finish',async()=>{throw new Error('UPDATE_RECOVERY_REQUIRED');}), e => e.failure.code === 'UPDATE_RECOVERY_REQUIRED');
  const result = await activateRelay(Object.fromEntries(stages.map(s=>[s, async()=>({stage:s})])));
  assert.deepEqual(result,{stage:'health'});
});

test('diagnostics are allowlisted, private, replace a symlink safely and clear after success', async t => {
  const root = await temporary(t); await mkdir(join(root,'.runtime'));
  const external = join(root,'unrelated'); await writeFile(external,'keep');
  await symlink(external,join(root,'.runtime/setup-failure.json'));
  const unsafe = {...fail('TAILSCALE_HTTPS_FAILED','https'),exitCode:1,signal:'SIGTERM',message:secret,stdout:secret,origin:secret};
  assert.deepEqual(readSetupFailure(unsafe), {...fail('TAILSCALE_HTTPS_FAILED','https'),exitCode:1,signal:'SIGTERM'});
  assert.equal(readSetupFailure({...unsafe,code:'PRIVATE_TOKEN'}),undefined);
  assert.equal(readSetupFailure({...unsafe,stage:secret}),undefined);
  assert.equal(await saveSetupFailure(root,unsafe),true);
  const text = await readFile(join(root,'.runtime/setup-failure.json'),'utf8');
  assert.doesNotMatch(text,/sk-test|stdout|origin|message/); assert.ok(JSON.parse(text).failedAt);
  assert.equal((await stat(join(root,'.runtime/setup-failure.json'))).mode & 0o777,0o600);
  assert.equal(await readFile(external,'utf8'),'keep');
  await clearSetupFailure(root);
  await assert.rejects(readFile(join(root,'.runtime/setup-failure.json')),/ENOENT/);
  assert.equal(await saveSetupFailure(join(root,'missing'),unsafe),false);
});

test('generic failures remain honest and every known failure has English and Japanese guidance', () => {
  assert.deepEqual(setupFailure(new Error(secret),'runtime-prepare'),fail('SETUP_FAILED','runtime-prepare'));
  assert.deepEqual(setupFailure(Object.assign(new Error(secret),{code:'ENOSPC'}),'config'),fail('SETUP_DISK_FULL','config'));
  assert.equal(setupFailure({code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:true,signal:'SIGTERM'},'install').code,'SETUP_COMMAND_FAILED');
  assert.deepEqual(setupFailure(setupError('TAILSCALE_LOGIN_REQUIRED'),'tailscale'),fail('TAILSCALE_LOGIN_REQUIRED','tailscale'));
  for(const table of [catalog.codes,catalog.stages]) for(const entry of Object.values(table)) {
    assert.ok(entry.en.length); assert.ok(entry.ja.length);
  }
});


test('legacy notification menu retains Japanese install guidance and a distinct pairing stage', async t => {
  const missing = await installFixture(t, 'missing');
  await assert.rejects(missing.execute(false), error => {
    const result = JSON.parse(error.stdout);
    assert.match(result.issues[0], /Tunnel接続設定/);
    assert.equal(result.failure.code, 'TUNNEL_CONFIG_MISSING');
    return true;
  });
  const pairing = await installFixture(t, 'pair');
  await assert.rejects(pairing.execute(false), error => {
    const result = JSON.parse(error.stdout);
    assert.equal(result.failure.stage, 'pairing');
    assert.match(result.issues[0], /接続コードの作成/);
    assert.doesNotMatch(error.stdout, /sk-test|private-host/);
    return true;
  });
});
