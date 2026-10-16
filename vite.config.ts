import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { evenBuild, sourceIdentity } from './scripts/lib/even-build.mjs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Development and ordinary builds stay visibly Beta. Release mode is explicit.
export default defineConfig(({mode}) => {
  const {sourceCommit, dirty} = sourceIdentity();
  const build = {...evenBuild(version, mode, sourceCommit, dirty), exitDiagnostics: mode === 'exit-check'};
  return {
    base: './', worker: {format: 'es'},
    define: {'import.meta.env.VITE_APP_VERSION': JSON.stringify(build.displayVersion),
      'import.meta.env.VITE_EXIT_DIAGNOSTICS': JSON.stringify(build.exitDiagnostics ? '1' : '0')},
    plugins: [{name: 'even-build-identity', generateBundle() {
      this.emitFile({type: 'asset', fileName: 'build-info.txt', source: JSON.stringify(build, null, 2) + '\n'});
    }}],
  };
});
