// Native GUI integration with disposable data and real child processes.
// --live-jobs additionally exercises launchd through an isolated label mapping.
// --baseline compiles the original main.swift to reproduce the reported failure.
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir, realpath, symlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

assert.equal(process.platform, 'darwin', 'Requires macOS AppKit');
const live = process.argv.includes('--live-jobs'), baseline = process.argv.includes('--baseline');
const root = await realpath(await mkdtemp(resolve('.runtime/quit-fixture-')));
const app = join(root, 'Dot Link.app'), contents = join(app, 'Contents'), payload = join(contents, 'Resources/payload');
const home = join(root, 'home'), directory = join(root, 'data');
const namespace = 'app.tripsurf.dotlink.quit-test.' + randomUUID().toLowerCase();
const domain = `gui/${process.getuid()}`, names = ['bridge', 'device', 'tunnel', 'setup-ui'];
const children = [], jobs = [];
const run = (file, args, options = {}) => {
  const r = spawnSync(file, args, {encoding: 'utf8', timeout: 90000, ...options});
  assert.equal(r.status, 0, `${file}: ${r.error ?? r.stderr ?? ''} signal=${r.signal ?? ''}`); return r.stdout;
};
const update = JSON.parse(await readFile('config/mac-update.json', 'utf8'));
const sdk = resolve('.runtime/vendor/sparkle-' + update.sparkle.version);
const saved = {'device-key': 'synthetic-pairing', 'bridge-state.json': 'synthetic-history', 'tunnel-api-key': 'synthetic-key'};
try {
  run(process.execPath, ['scripts/prepare-sparkle.mjs']);
  for (const path of ['MacOS', 'Frameworks', 'Resources/payload/.runtime/bin', 'Resources/payload/scripts']) await mkdir(join(contents, path), {recursive: true});
  await mkdir(join(directory, '.runtime'), {recursive: true});
  await mkdir(join(home, 'Library/LaunchAgents'), {recursive: true});
  await cp(join(sdk, 'Sparkle.framework'), join(contents, 'Frameworks/Sparkle.framework'), {recursive: true, verbatimSymlinks: true});
  await cp('localization', join(payload, 'localization'), {recursive: true});
  await symlink(process.execPath, join(payload, '.runtime/bin/node'));
  await writeFile(join(root, 'mode'), 'stop');
  for (const [file, value] of Object.entries(saved)) await writeFile(join(directory, '.runtime', file), value);
  await writeFile(join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${namespace}</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleExecutable</key><string>Test</string><key>CFBundleVersion</key><string>1</string></dict></plist>`);
  const pids = {};
  for (const name of names) {
    const plist = {Label: `local.even-g2-dot.${name}`, WorkingDirectory: name === 'setup-ui' ? join(home, 'Applications/Dot Link.app/Contents') : directory,
      ProgramArguments: name === 'setup-ui' ? [join(home, 'Applications/Dot Link.app/Contents/MacOS/DotLink'), '--background']
        : name === 'tunnel' ? ['tunnel', '--profile-file', join(directory, '.runtime/tunnel.yaml')]
        : ['node', join(directory, 'server', name === 'bridge' ? 'main.ts' : 'device-main.ts')]};
    await writeFile(join(home, 'Library/LaunchAgents', plist.Label + '.plist'), JSON.stringify(plist));
    if (name === 'setup-ui') continue;
    if (live) {
      const label = namespace + '.' + name, path = join(root, name + '.plist');
      await writeFile(path, `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/bin/sleep</string><string>300</string></array><key>RunAtLoad</key><true/></dict></plist>`);
      jobs.push(label); run('/bin/launchctl', ['bootstrap', domain, path]);
    } else {
      const child = spawn('/bin/sleep', ['300'], {stdio: 'ignore'}); children.push(child); pids[name] = child.pid;
    }
  }
  await writeFile(join(root, 'pids.json'), JSON.stringify(pids));
  // Use the real ownership checks, lifecycle persistence, stop/wait implementation.
  // The adapter maps only this fixture's exact known job targets; it cannot touch
  // a real local.even-g2-dot launch job, even with --live-jobs.
  await writeFile(join(payload, 'scripts/mac-setup.mjs'), `
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {suspendServices} from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/app-lifecycle.mjs')).href)};
const root=${JSON.stringify(root)},home=${JSON.stringify(home)},directory=${JSON.stringify(directory)};
const names=${JSON.stringify(names)},domain=${JSON.stringify(domain)},namespace=${JSON.stringify(namespace)},live=${live};
const pids=JSON.parse(await readFile(join(root,'pids.json'),'utf8'));
const mode=await readFile(join(root,'mode'),'utf8');
if(mode==='no-result')process.exit(7);
if(mode==='stop-error'){console.log(JSON.stringify({kind:'error',code:'SERVICE_STILL_STOPPING'}));process.exit(1);}
const execute=async(file,args)=>{
 if(file==='/bin/launchctl'){
  const name=names.find(n=>args[1]===domain+'/local.even-g2-dot.'+n);
  if(!name||!['disable','print','bootout'].includes(args[0]))throw Error('Unexpected fixture launchctl target');
  if(live)return execFileSync(file,[args[0],domain+'/'+namespace+'.'+name],{encoding:'utf8'});
  if(args[0]==='disable')return '';
  if(args[0]==='print'){if(!pids[name])throw Error('not loaded');return 'pid = '+pids[name];}
  process.kill(pids[name],'SIGTERM');delete pids[name];return '';
 }
 if(file==='/usr/bin/plutil'||file==='/bin/ps'){try{return execFileSync(file,args,{encoding:'utf8'});}catch(error){error.code=error.status;throw error;}}
 throw Error('Unexpected fixture command');
};
try {await suspendServices(directory,{home,execute,reason:'quit'});await writeFile(join(root,'stop-confirmed'),'yes');console.log(JSON.stringify({kind:'result',quitReady:true}));}
catch(error){console.log(JSON.stringify({kind:'error',code:error.message}));process.exitCode=1;}
`);
  const source = baseline ? run('git', ['show', 'db49cacb522258b40844ca9ff017f934820e8d5a:native/DotLinkSetup/main.swift']) : await readFile('native/DotLinkSetup/main.swift', 'utf8');
  const boundary = '\nif CommandLine.arguments.contains("--stt-credential")';
  assert.equal(source.split(boundary).length, 2, 'Only replace production top-level entry point');
  await writeFile(join(root, 'main.swift'), source.split(boundary)[0] + '\n' + await readFile('tests/mac-quit-recovery.swift', 'utf8'));
  const sources = (await readdir('native/DotLinkSetup')).filter(f => f.endsWith('.swift') && f !== 'main.swift').map(f => 'native/DotLinkSetup/' + f);
  run('/usr/bin/xcrun', ['swiftc', '-module-cache-path', resolve('.runtime/swift-module-cache'), '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'UserNotifications', '-F', sdk, '-framework', 'Sparkle',
    '-Xlinker', '-rpath', '-Xlinker', '@executable_path/../Frameworks', ...(baseline ? ['-D', 'BASELINE'] : []), ...sources,
    'native/NotificationMenu/DotStatus.swift', 'native/NotificationMenu/NotificationProbeResult.swift', join(root, 'main.swift'), '-o', join(contents, 'MacOS/Test')]);
  const images = process.env.QUIT_FIXTURE_IMAGES;
  if (images) await mkdir(images, {recursive: true});
  const output = run(join(contents, 'MacOS/Test'), process.argv.slice(2).filter(arg => ['--baseline', '--remove-bundle'].includes(arg)), {env: {...process.env, QUIT_FIXTURE_ROOT: root}, timeout: 45000});
  assert.equal(await readFile(join(root, 'gui-exited'), 'utf8'), 'GUI exited after quitReady');
  assert.equal(await readFile(join(root, 'stop-confirmed'), 'utf8'), 'yes');
  assert.deepEqual(JSON.parse(await readFile(join(directory, '.runtime/lifecycle.json'), 'utf8')), {stopped: true, reason: 'quit'});
  for (const [file, value] of Object.entries(saved)) assert.equal(await readFile(join(directory, '.runtime', file), 'utf8'), value);
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  for (const child of children) assert.throws(() => process.kill(child.pid, 0), {code: 'ESRCH'});
  for (const label of jobs) assert.notEqual(spawnSync('/bin/launchctl', ['print', domain + '/' + label]).status, 0);
  console.log(output.trim());
  console.log('PASS: ' + (live ? 'isolated launchd jobs' : 'disposable child processes') + ' stopped; lifecycle, pairing/settings/history retained');
} finally {
  for (const child of children) { try { child.kill('SIGTERM'); } catch {} }
  for (const label of [...jobs, namespace + '.setup-ui']) {
    if (live) {
      spawnSync('/bin/launchctl', ['bootout', domain + '/' + label]);
      spawnSync('/bin/launchctl', ['enable', domain + '/' + label]);
    }
  }
  // Also clean preferences if an assertion or AppKit startup failure prevented
  // applicationWillTerminate from running. This is only the unique test domain.
  spawnSync('/usr/bin/defaults', ['delete', namespace]);
  await rm(root, {recursive: true, force: true});
}
