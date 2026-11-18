#!/usr/bin/env node
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = resolve(rootDir, 'dist/index.js');

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [resolve(rootDir, 'src/index.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'linked',
  logLevel: 'info',
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
});

