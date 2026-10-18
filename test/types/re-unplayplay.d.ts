// Ambient types for re-unplayplay (the native PlayPlay bridge, runtime dep).
// The package ships no .d.ts; only the surface the project uses is declared.
// API per dist/src/js/re-unplayplay/index.js; reference vector in
// dist/tests/js/unit.test.js: decryptAndBindKey(Buffer.from('01','hex'), '01')
// === 7EE4480B767DD92A03E90A7FC1FF4099.
declare module 're-unplayplay' {
    export function decryptKey(encryptedKey: Buffer): Buffer;
    export function bindKey(decryptedKey: Buffer, fileId: string): Buffer;
    export function decryptAndBindKey(encryptedKey: Buffer, fileId: string): Buffer;
    export function getToken(): Buffer;
}
