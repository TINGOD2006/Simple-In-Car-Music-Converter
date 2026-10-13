/**
 * Audio USB Studio — web UI server entry point.
 *
 * Usage:
 *   node src/server/main.ts [--port 4173] [--ffmpeg-dir <dir>] [--web <dist>] [--scratch <dir>]
 *
 * Serves the JSON API under /api/* and, when `--web` points at a built UI,
 * the static bundle at /.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { startServer } from './index.ts';
import { assetRoot, appRoot } from '../core/approot.ts';

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/**
 * Where the built UI lives by default.
 *
 * A packaged build embeds `web/dist` as SEA assets, which the launcher extracts
 * to `AUS_ASSET_ROOT`; a source checkout keeps it under `web/dist`. Both are
 * tried so the same code serves either layout.
 */
function defaultWebRoot(): string | undefined {
  const candidates = [resolve(assetRoot(), 'web', 'dist'), resolve(appRoot(), 'web', 'dist')];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

export interface ServerRunOptions {
  /** Print the banner and bind signal handlers. Defaults to true. */
  announce?: boolean;
  /** Open the default browser at the served URL once listening. Defaults to false. */
  openBrowser?: boolean;
}

/**
 * Parse `argv` (without node/script), start the HTTP server, and keep running
 * until interrupted. Exported so the packaged launcher and the source entry
 * point share one implementation.
 */
export async function runServer(argv: string[], opts: ServerRunOptions = {}): Promise<void> {
  const portRaw = flagValue(argv, 'port');
  const port = portRaw ? Number(portRaw) : 4173;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port "${portRaw}"`);
  }

  const webRaw = flagValue(argv, 'web');
  let webRoot: string | undefined;
  if (webRaw) {
    webRoot = resolve(webRaw);
    if (!existsSync(webRoot)) {
      console.error(`WARNING: --web directory does not exist: ${webRoot} (API only)`);
      webRoot = undefined;
    }
  } else {
    webRoot = defaultWebRoot();
  }

  const { server, port: bound } = await startServer({
    port,
    ffmpegDir: flagValue(argv, 'ffmpeg-dir'),
    webRoot,
    scratchRoot: flagValue(argv, 'scratch'),
  });

  const url = `http://127.0.0.1:${bound}/`;

  if (opts.announce !== false) {
    console.log(`AudioUsbStudio server listening on http://127.0.0.1:${bound}`);
    console.log(`  API   http://127.0.0.1:${bound}/api/health`);
    console.log(webRoot ? `  UI    ${url}` : '  UI    (not served — pass --web <dist>)');
  }

  if (opts.openBrowser && webRoot) {
    // Report the outcome rather than firing and forgetting: a silent failure here
    // is indistinguishable from "nothing happened", which is precisely the
    // complaint this path exists to answer.
    const opened = await openInBrowser(url);
    if (opened) {
      if (opts.announce !== false) {
        // `opened` means a launcher process started, not that a window appeared.
        // The address is therefore printed on success too: "I saw nothing happen"
        // is the complaint this whole path exists to answer, and a user who cannot
        // see a browser window needs the address in front of them either way.
        console.log('  Starting your browser…');
        console.log(`  If no editor window appears, open this address yourself:`);
        console.log('');
        console.log(`      ${url}`);
        console.log('');
      }
    } else if (opts.announce !== false) {
      console.log('');
      console.log('  Could not start a browser automatically.');
      console.log('  Open this address by hand to use the editor:');
      console.log('');
      console.log(`      ${url}`);
      console.log('');
      console.log('  (The server is running. Leave this window open; close it to quit.)');
    }
  } else if (opts.openBrowser && !webRoot && opts.announce !== false) {
    console.log('  Could not open a browser: no UI bundle was found to serve.');
  }

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Browser launchers to try, in order of preference.
 *
 * `cmd /c start` is the cheapest and normally correct, but it is also the one an
 * application-control policy or a locked-down machine is most likely to block.
 * The alternatives mean a blocked `cmd` costs a fallback rather than the whole
 * launch: `explorer.exe` and `rundll32 url.dll,FileProtocolHandler` both hand a
 * URL to the registered default browser without going through `cmd`.
 */
function browserLaunchers(url: string): Array<{ cmd: string; args: string[] }> {
  if (process.platform === 'win32') {
    return [
      { cmd: 'cmd', args: ['/c', 'start', '', url] },
      { cmd: 'explorer.exe', args: [url] },
      { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] },
      {
        cmd: 'powershell.exe',
        args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${url}'`],
      },
    ];
  }
  if (process.platform === 'darwin') return [{ cmd: 'open', args: [url] }];
  return [
    { cmd: 'xdg-open', args: [url] },
    { cmd: 'gio', args: ['open', url] },
  ];
}

/**
 * Spawn one detached, fire-and-forget launcher.
 *
 * Resolves `true` once the launcher process actually starts, `false` on any
 * failure. Never rejects.
 *
 * The `error` listener is load-bearing, not defensive noise: `spawn` reports a
 * missing or policy-blocked binary *asynchronously*, so the surrounding
 * `try/catch` never sees it. With no listener, that error is unhandled and Node
 * terminates the process — which is exactly how a packaged build dies right after
 * printing its banner, taking the server down before the user can react.
 */
function startDetached(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

/**
 * Try to open `url` in the user's default browser.
 *
 * Resolves `true` when some launcher started, `false` when every strategy failed.
 * Best-effort by design: a machine that refuses to launch a browser must still get
 * a working server, so this never throws and never takes the process with it. The
 * caller is responsible for telling the user the URL when this returns `false`.
 */
export async function openInBrowser(
  url: string,
  launchers: Array<{ cmd: string; args: string[] }> = browserLaunchers(url),
): Promise<boolean> {
  for (const { cmd, args } of launchers) {
    if (await startDetached(cmd, args)) return true;
  }
  return false;
}

/* Run only when this file is the process entry point; the packaged launcher
 * imports `runServer` instead, so the side effect must not fire there. */
const isEntryPoint = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  runServer(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  });
}
