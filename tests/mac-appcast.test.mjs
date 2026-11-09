import test from 'node:test';
import assert from 'node:assert/strict';
import {macAppcast} from '../scripts/lib/mac-appcast.mjs';
const input={version:'0.4.99',build:'999',notes:'- Keep A & B <safe>.',downloadRepository:'owner/repo',tag:'mac-v0.4.99-999',name:'app.zip',signature:'signed',size:42};
test('release feed carries the actual bundle minimum rather than a fixed OS floor',()=>{
  for(const minimumSystemVersion of ['13.5','14.2.1']) {
    const xml=macAppcast({...input,minimumSystemVersion});
    assert.ok(xml.includes(`<sparkle:minimumSystemVersion>${minimumSystemVersion}</sparkle:minimumSystemVersion>`));
    assert.match(xml,/<sparkle:version>999<\/sparkle:version>/);
    assert.match(xml,/length="42"/);assert.match(xml,/A &amp; B &lt;safe&gt;/);
  }
  for(const minimumSystemVersion of [undefined,'','13.bad','13.5</x>'])assert.throws(()=>macAppcast({...input,minimumSystemVersion}),/Invalid minimum/);
});
