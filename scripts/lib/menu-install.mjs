import { access, readFile, writeFile, mkdir, cp, mkdtemp, rename, rm, lstat, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { run, launchAgent } from './setup.mjs';
const exists = path => access(path).then(()=>true,()=>false);
const identifier='app.tripsurf.dotlink.mac';
export async function resolvedMenuAppPath(home=homedir()) {
  const root=await realpath(home), parent=join(root,'Applications');
  try {
    if((await lstat(parent)).isSymbolicLink())throw new Error('UNSAFE_INSTALL_PATH');
    const actual=await realpath(parent);
    if(dirname(actual)!==root)throw new Error('UNSAFE_INSTALL_PATH');
    const app=join(actual,'Dot Link.app');
    try {
      if((await lstat(app)).isSymbolicLink())throw new Error('UNSAFE_INSTALL_PATH');
      return await realpath(app);
    } catch(error) { if(error.code==='ENOENT')return app; throw error; }
  } catch(error) { if(error.code==='ENOENT')return join(parent,'Dot Link.app'); throw error; }
}
export async function installMenuApp(source, {home=homedir(),execute=run,verify=async()=>{}}={}) {
  const identity = path => execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents/Info.plist')]);
  if(await identity(source)!==identifier)throw new Error('APP_BUNDLE_INVALID');
  const destination=await resolvedMenuAppPath(home);
  // Keep the registration contract consistent with lifecycle ownership checks.
  // Filesystem operations still use the safely resolved destination.
  const registeredPath=join(home,'Applications/Dot Link.app');
  if(await exists(destination)) {
    if(await identity(destination)!==identifier)throw new Error('APP_BUNDLE_CONFLICT');
    // Updating an existing app is a separate operation, never an unreviewed overwrite.
    return registeredPath;
  }
  await mkdir(dirname(destination),{recursive:true});
  if((await lstat(dirname(destination))).isSymbolicLink() || await realpath(dirname(destination))!==dirname(destination))throw new Error('UNSAFE_INSTALL_PATH');
  const staging=await mkdtemp(join(dirname(destination),'.Dot-Link-app-'));
  const candidate=join(staging,'Dot Link.app');
  try {
    await cp(source,candidate,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
    await verify(candidate);
    // Never knowingly replace an app installed while the copy was in progress.
    try { await lstat(destination); throw new Error('APP_BUNDLE_CONFLICT'); }
    catch(error) { if(error.code!=='ENOENT')throw error; }
    await rename(candidate,destination);
  } finally { await rm(staging,{recursive:true,force:true}); }
  return registeredPath;
}
export async function registerMenuApp(app,{home=homedir(),execute=run}={}) {
  const label='local.even-g2-dot.setup-ui';
  const destination=join(home,'Library/LaunchAgents'); await mkdir(destination,{recursive:true});
  const file=join(destination,label+'.plist');
  if(await exists(file)) {
    const previous=JSON.parse(await execute('/usr/bin/plutil',['-convert','json','-o','-',file]));
    if(previous.Label!==label || previous.ProgramArguments?.[0]!==join(app,'Contents/MacOS/DotLink'))throw new Error('MENU_SERVICE_CONFLICT');
  }
  // The GUI is already running for this setup. Register the next-login launch only.
  const xml=launchAgent(label,[join(app,'Contents/MacOS/DotLink'),'--background'],join(app,'Contents'),{},true);
  // GUI logs are not needed and the installed app is treated as immutable.
  const content=xml.replace(/<key>StandardOutPath<\/key><string>[^<]*<\/string><key>StandardErrorPath<\/key><string>[^<]*<\/string>/,'');
  const old=await readFile(file,'utf8').catch(()=>undefined);
  if(old!==content)await writeFile(file,content,{mode:0o600});
  await execute('/bin/launchctl',['enable',`gui/${process.getuid()}/${label}`]);
}
