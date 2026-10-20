import { defineConfig } from 'tsdown'

/**
 * Bundle the compiled JavaScript the TypeScript build emits for the plugin.
 * DSH 0.2.1 no longer ships the former invariant companion service.
 */
export default defineConfig([
  {
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
