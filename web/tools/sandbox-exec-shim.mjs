/**
 * Sandbox compatibility shim for Vite's Windows realpath probe.
 *
 * WHY THIS EXISTS
 * ---------------
 * This machine's DSH sandbox forbids ANY subprocess with piped stdio
 * (`spawn EPERM`, errno -4048) — the same documented boundary that forces the
 * engine to talk to ffmpeg through files instead of stdout (docs/ENVIRONMENT.md §2.1).
 *
 * On Windows, Vite/Rolldown calls `child_process.exec("net use")` once from
 * `optimizeSafeRealPathSync()` (vite/dist/node/chunks/node.js) purely to discover
 * UNC network-drive mappings. `exec` needs pipes, so in this sandbox `spawn` throws
 * EPERM *synchronously* — before Vite's own `if (error) return;` fallback can run —
 * and that aborts `vite build` while it bundles the config file.
 *
 * Vite's intended behaviour when that probe fails is to fall back to
 * `fs.realpathSync.native`, which is correct here (no network drives are involved).
 * So we make exactly that one probe report failure asynchronously instead of
 * throwing, and pass every other child_process call through untouched.
 *
 * This changes no build output; it only lets Vite take the fallback branch it
 * already implements. Loaded via `node-options` in web/.npmrc so that a plain
 * `npx vite build` works with no extra flags.
 */

import childProcess from 'node:child_process';

const originalExec = childProcess.exec;
const originalExecFile = childProcess.execFile;

/** `net use` is Vite's Windows UNC-drive probe, and it is optional. */
function isNetUseProbe(command, args) {
  const cmd = String(command == null ? '' : command).trim();
  if (/^net(\.exe)?\s+use$/i.test(cmd)) return true;
  if (/^net(\.exe)?$/i.test(cmd)) {
    const first = Array.isArray(args) ? String(args[0] == null ? '' : args[0]) : '';
    return first.toLowerCase() === 'use';
  }
  return false;
}

function makeEperm() {
  const err = new Error('spawn EPERM (sandbox: piped stdio unavailable)');
  err.code = 'EPERM';
  err.errno = -4048;
  err.syscall = 'spawn';
  return err;
}

function reportProbeFailure(callback) {
  if (typeof callback === 'function') {
    queueMicrotask(function () {
      callback(makeEperm());
    });
  }
  return undefined;
}

childProcess.exec = function patchedExec(command) {
  if (isNetUseProbe(command, undefined)) {
    const rest = Array.prototype.slice.call(arguments, 1);
    return reportProbeFailure(rest.find(function (a) { return typeof a === 'function'; }));
  }
  return originalExec.apply(childProcess, arguments);
};

childProcess.execFile = function patchedExecFile(file) {
  const rest = Array.prototype.slice.call(arguments, 1);
  const args = Array.isArray(rest[0]) ? rest[0] : undefined;
  if (isNetUseProbe(file, args)) {
    return reportProbeFailure(rest.find(function (a) { return typeof a === 'function'; }));
  }
  return originalExecFile.apply(childProcess, arguments);
};
