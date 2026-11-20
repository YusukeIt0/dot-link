import test from 'node:test';
import assert from 'node:assert/strict';
import { FactorHistorySettings } from '../src/factor-history-settings.ts';

const status = {protocol:1, terms:'selected-factor-history-v1', epoch:'one', period:'7d',
  sources:{weather:false,mobility:false,location:false,polar:false}, polarEpoch:'health-one', polarAvailable:true};
test('reopening reads the Mac choice, a duration never enrolls another source, and a lost acknowledgement is reconciled', async () => {
  let current = structuredClone(status);
  const commands: any[] = [];
  const panel = new FactorHistorySettings({changed() {}, request: async raw => {
    if (!raw) return current;
    const command = raw as any;
    commands.push(command);
    if (command.change.action === 'period') current = {...current, period:command.change.period, epoch:'two'};
    if (command.change.source === 'polar') {
      current = {...current, sources:{...current.sources,polar:true}, epoch:'three', polarEpoch:'health-two'};
      throw new Error('Response interrupted after saving');
    }
    return current;
  }});
  panel.receive('same-mac',true);
  assert.equal(panel.status().settings, undefined);
  await panel.refresh();
  await panel.change({action:'period',period:'6m'});
  assert.deepEqual(panel.status().settings?.sources,status.sources);
  await panel.change({action:'set',source:'polar',enabled:true});
  assert.equal(commands[1].epoch,'two');
  assert.equal(commands[1].polarEpoch,'health-one');
  assert.equal(panel.status().settings?.sources.polar,true);
  assert.equal(panel.status().failed,true);
  panel.receive(undefined,false);
  panel.receive('same-mac',true);
  await panel.refresh();
  assert.equal(panel.status().settings?.period,'6m');
  assert.equal(commands.length,2);
});
test('an unfinished request on a previous Mac cannot restore or change the next Mac’s settings', async () => {
  let release!: (s: unknown) => void;
  const panel = new FactorHistorySettings({changed(){}, request:()=>new Promise(resolve=>{release=resolve;})});
  panel.receive('first',true);
  const pending=panel.refresh();
  panel.receive('second',true);
  release({...status,sources:{...status.sources,weather:true}});
  await pending;
  assert.equal(panel.status().settings,undefined);
  const fresh=panel.refresh();
  release(status);
  await fresh;
  assert.equal(panel.status().settings?.sources.weather,false);
});
