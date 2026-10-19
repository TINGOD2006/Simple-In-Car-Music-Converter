/**
 * Type surface for `tools/fetch-ytdlp.mjs`.
 *
 * The script is plain `.mjs` and `tsconfig.json` does not enable `allowJs`, so
 * without this file `test/fetch-ytdlp.test.ts` fails to typecheck with
 * `TS2307: Cannot find module '../tools/fetch-ytdlp.mjs'`. Hand-writing the
 * surface mirrors what `src/vendor/download-deps.d.ts` already does for the
 * generated vendor bundle.
 */

export declare const VERSION: string;
export declare const ASSET: string;
export declare const URL: string;
export declare const EXPECTED_SIZE: number;
export declare const EXPECTED_SHA256: string;
export declare function parseArgs(argv: string[]): { out: string };
