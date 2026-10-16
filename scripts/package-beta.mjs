// Preserve the existing Beta entry point; release packaging uses package-even directly.
if (process.argv.includes('--release')) throw new Error('Use npm run package:release for a main release');
await import('./package-even.mjs');
