// esbuild alias target for the `supports-color` package (required by the
// debug graph pulled in by @distube/ytdl-core). The real package is not
// installed, and its top-level require must not become a runtime lookup in the
// packaged SEA (no node_modules beside it). debug only uses it for terminal
// colours; `false` makes every guarded lookup degrade to "no colour".
// NOTE: .cjs on purpose — the repo package.json is "type": "module", and a
// CJS-shaped .js stub would be parsed as ESM.
module.exports = false;
