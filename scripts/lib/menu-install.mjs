import { access, readFile, writeFile, mkdir, cp, mkdtemp, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { run, launchAgent } from './setup.mjs';
const exists = path => access(path).then(()=>true,()=>false);
const identifier='app.tripsurf.dotlink.mac';
export async function installMenuApp(source, {home=homedir(),execute=run}={}) {
  const identity = path => execute('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(path,'Contents/Info.plist')]);
  if(await identity(source)!==identifier)throw new Error('APP_BUNDLE_INVALID');
  const destination=join(home,'Applications/Dot Link.app');
  if(await exists(destination)) {
    if(await identity(destination)!==identifier)throw new Error('APP_BUNDLE_CONFLICT');
    // Updating an existing app is a separate operation, never an unreviewed overwrite.
    return destination;
  }
  await mkdir(dirname(destination),{recursive:true});
  const staging=await mkdtemp(join(dirname(destination),'.Dot-Link-app-'));
  const candidate=join(staging,'Dot Link.app');
  await cp(source,candidate,{recursive:true,errorOnExist:true,force:false});
  await rename(candidate,destination);
  return destination;
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
