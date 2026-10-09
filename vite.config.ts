import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// Packaged WebViews load assets relative to index.html, not the Mac server root.
export default defineConfig({ base: './', define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(version) } });
