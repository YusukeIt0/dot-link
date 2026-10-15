// Node runs each test file in an isolated process, including the WASM host.
process.env.DOT_TEST_WAKE_NAME = 'Sakura';
await import('./wake-runtime.test.ts');
export {};
