// Bundles the third-party download dependency (the vendored spdl Spotify
// client) into a single ESM file. The ONLY external kept is re-unplayplay — a
// native prebuilt that ships as real files beside the packaged exe (see
// tools/vendor/spdl-src/PATCHES.md). Run: node tools/bundle-download-vendor.mjs
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const result = await build({
    entryPoints: [path.join(root, 'tools', 'vendor', 'download-entry.ts')],
    outfile: path.join(root, 'src', 'vendor', 'download-deps.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['re-unplayplay'],
    // CJS deps (undici, protobufjs, debug…) call require() at runtime; the bare
    // ESM output has no require, so provide one via createRequire. Builtins
    // resolve anywhere; the only package require left is stubbed out below.
    banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    alias: {
        // debug/chalk's top-level require('supports-color') would crash the
        // packaged exe (no node_modules). Colours are cosmetic — stub it.
        'supports-color': path.join(root, 'tools', 'vendor', 'stubs', 'supports-color.cjs'),
    },
    minify: false,
    sourcemap: false,
    // Keep third-party licence notices (esbuild's default). Setting 'none' here
    // would make this command emit a file 1 041 bytes smaller than the committed
    // src/vendor/download-deps.js: every run would dirty the tree AND silently
    // drop the undici / ws / long.js notices. The committed bundle is the
    // output of THIS script, so the option must stay at the default.
    legalComments: 'eof',
    logLevel: 'info',
    metafile: true,
});

const outputs = Object.keys(result.metafile.outputs);
console.log('outputs:', outputs.join(', '));
