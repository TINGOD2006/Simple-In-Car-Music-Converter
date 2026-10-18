# Vendored spdl — provenance and patches

Source: https://github.com/PwLDev/node-spdl (the `spdl` TypeScript library).
Pinned commit: `d01c4044a59332d437b2b322ad7619f60f719240` (main HEAD, 2026-01-18, GPG-signed).
The package was never published to npm under any name (`spdl` unpublished 2021;
`node-spdl` never existed), and the repository has no tags, no dist/, and no
prepare script — so the source is vendored directly and compiled by
`tools/bundle-download-vendor.mjs` into `src/vendor/download-deps.js`.

## Why vendoring

AudioUsbStudio's packaged executable is a Node SEA whose assets are materialised
as plain files (`tools/launcher.cjs`). `tools/build-exe.mjs` only collects
`.js` assets and assumes `build/**/*.js` contains zero bare (node_modules)
imports. A single bundled façade keeps that invariant: everything third-party is
compiled into `src/vendor/download-deps.js`, and `src/core/download/deps.ts` is
the only importing module.

## Applied patches (all marked `PATCH (AudioUsbStudio)` in the files)

1. `src/lib/proto.ts` — upstream loaded `../proto/playplay.proto` from disk at
   module top level (`proto.loadSync`). Bundled SEA code cannot rely on
   CWD-relative fs paths, and only `.js` assets are materialised. The proto is
   now a static JSON descriptor generated into
   `src/lib/playplay-proto.gen.ts` (from the vendored `proto/playplay.proto`)
   and decoded with `protobufjs.Root.fromJSON`. The unused CWD-relative
   `resolveProto()` helper was removed.
2. `src/lib/client.ts` — removed the top-level `import unplayplay from
   "@spdl/unplayplay"` and the `options.unplayplay` injection. That package is
   an unpublished native addon (npm 404; tarball ships only node-gyp sources,
   no prebuilt binary, no install possible in this sandbox). See patch 3.
3. `src/lib/playplay.ts` — the native bridge is imported lazily inside
   `getKey()` and switched to `re-unplayplay` (es3n1n's clean rewrite of
   pbdecrypt.cc, ships prebuilt binaries; API: `getToken()`,
   `decryptAndBindKey(encryptedKey, fileId)` — argument order differs from the
   old `deobfuscateKey(fileId, key)`). A stray `console.log` of key material
   was removed. IMPORTANT: contrary to earlier assumptions, EVERY Spotify
   format except MP3_96 is PlayPlay-encrypted — OGG_VORBIS included
   (`content.ts` OGG branch calls `client.playplay.getKey`).
4. The fire-and-forget error bug in upstream's `spdl()`/`Spotify.download()`
   (async work started without await; rejections became unhandled and streams
   hung) is fixed in the bundle entry `tools/vendor/download-entry.ts`, which
   composes the download pipeline itself and destroys the stream with the
   caught error.

## Packaging contract

`re-unplayplay` stays EXTERNAL in the bundle (lazy `import("re-unplayplay")`)
and its package directory — JS wrapper, `binding-options.js`, `package.json`,
and `prebuilds/re-unplayplay-js-win32-x64/` — ships beside the packaged exe
under `node_modules/`, exactly like the ffmpeg sidecar. `pkg-prebuilds` (pure
JS loader) ships likewise. Task 9 wires this into `tools/build-exe.mjs`.
