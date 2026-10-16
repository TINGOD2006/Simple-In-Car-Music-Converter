/**
 * The bridge to the desktop shell.
 *
 * Inside the shell the page runs in a WebView2 control whose host injects
 * `window.chrome.webview` (see `desktop/MainForm.cs`). That host can show a real
 * file dialog and hand back real absolute paths — the one thing a web page
 * cannot otherwise obtain, because a browser's `<input type="file">` deliberately
 * hides the path behind a fake filename.
 *
 * EVERYTHING HERE IS TRANSPORT-INJECTED. `bridgePick` never reaches for `window`,
 * so it runs — and is tested — in plain node (`test/native-bridge.test.ts`).
 * That is also why this file has no imports: the engine's `tsconfig.json`
 * type-checks it through that test, and it is compiled with no DOM lib.
 *
 * In a plain browser `detectNativeTransport()` returns null. That is a supported
 * configuration, not a failure: the caller uses the engine's own `POST /api/pick`
 * and, if that answers 501, an upload.
 */

export type NativeTransport = {
  post(message: unknown): void;
  subscribe(handler: (data: unknown) => void): () => void;
};

/** Mirrors `PickMode` in `api-types.ts`; kept local so this file needs no imports. */
export type PickMode = 'files' | 'folder';

export interface PickOptions {
  title?: string;
  multiple?: boolean;
  /** How long to wait for the host before treating the bridge as broken. */
  timeoutMs?: number;
}

/**
 * A dialog is user-paced, so this is deliberately generous: it exists to stop a
 * broken host from hanging a promise forever, not to time the user out.
 *
 * Ten minutes, not two. Browsing a full USB stick for the right folder is the
 * normal case here, and the old two-minute ceiling fired on people who were
 * simply still looking. It was not harmless: the timeout looked like a failure,
 * the caller escalated to the engine's own dialog, and the user was left with a
 * second folder window on top of the first — which reads as "I had to choose the
 * folder twice, and then more windows kept opening".
 */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 10 * 60_000;

/** Marker carried by {@link BridgeTimeoutError}; callers must not treat it as a missing dialog. */
export const BRIDGE_TIMEOUT_CODE = 'bridge-timeout';

/**
 * The host never answered — not "the host has no dialog".
 *
 * The distinction is load-bearing. A shell that answers "I cannot show a dialog"
 * is a reason to fall back to the engine's dialog; a shell that has not answered
 * yet probably still has one open, and opening a second one is the bug above.
 */
export class BridgeTimeoutError extends Error {
  readonly code = BRIDGE_TIMEOUT_CODE;
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`native pick timeout after ${timeoutMs}ms: the desktop shell did not answer`);
    this.name = 'BridgeTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** True for the "nobody answered" case, which must never trigger a second dialog. */
export function isBridgeTimeout(err: unknown): boolean {
  return err instanceof BridgeTimeoutError;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function asFunction(value: unknown): ((...args: unknown[]) => unknown) | null {
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown) : null;
}

/**
 * Recognise the host object the desktop shell injects.
 *
 * Returns null when there is no usable host: a plain browser, or a `chrome.webview`
 * that is missing either half of the contract. Both halves are required, because a
 * host that can post but never answers would otherwise produce a promise that only
 * the timeout can end.
 */
export function detectNativeTransport(scope: unknown = globalThis): NativeTransport | null {
  const root = asRecord(scope);
  const chrome = root ? asRecord(root['chrome']) : null;
  const webview = chrome ? asRecord(chrome['webview']) : null;
  if (!webview) return null;

  const postMessage = asFunction(webview['postMessage']);
  const addEventListener = asFunction(webview['addEventListener']);
  if (!postMessage || !addEventListener) return null;
  const removeEventListener = asFunction(webview['removeEventListener']);

  return {
    post(message: unknown): void {
      postMessage(message);
    },
    subscribe(handler: (data: unknown) => void): () => void {
      const listener = (event: unknown): void => {
        handler(asRecord(event)?.['data']);
      };
      addEventListener('message', listener);
      return () => {
        if (removeEventListener) removeEventListener('message', listener);
      };
    },
  };
}

let nextId = 0;

/**
 * Ask the shell to show a dialog and resolve with the chosen paths.
 *
 * Resolves to `null` when the user cancels: cancelling is a normal outcome, and
 * callers must not raise an error banner for it. Rejects when the bridge itself
 * fails — the host reported an error, or never answered. A rejection means "this
 * route is unavailable", so the caller falls back to HTTP and then to upload.
 */
export function bridgePick(
  transport: NativeTransport,
  mode: PickMode,
  opts: PickOptions = {},
): Promise<string[] | null> {
  const id = `pick-${nextId++}`;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;

  return new Promise<string[] | null>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (unsubscribe) unsubscribe();
      complete();
    };

    timer = setTimeout(() => {
      finish(() => reject(new BridgeTimeoutError(timeoutMs)));
    }, timeoutMs);

    // Subscribe before posting so an answer cannot arrive before anyone listens.
    unsubscribe = transport.subscribe((data) => {
      const reply = asRecord(data);
      // Answers are matched by id, so two dialogs in flight cannot steal each
      // other's result and a late answer from an earlier dialog is ignored.
      if (!reply || reply['id'] !== id) return;

      if (reply['cancelled'] === true) {
        finish(() => resolve(null));
        return;
      }

      // A success is recognised either way. `ok: true` is the current contract, but a shell
      // built before that field existed answers with the paths alone — and reading those
      // replies as failures is precisely what made a finished pick escalate to the engine's
      // dialog and open a second folder window. `ok` may only *deny* a success, never make
      // one unreadable.
      const okFlag = reply['ok'];
      if (okFlag === true || (okFlag === undefined && Array.isArray(reply['paths']))) {
        const raw = reply['paths'];
        const paths = Array.isArray(raw)
          ? raw.filter((p): p is string => typeof p === 'string')
          : [];
        finish(() => resolve(paths));
        return;
      }

      const message =
        typeof reply['error'] === 'string' && reply['error'].length > 0
          ? reply['error']
          : 'the desktop shell could not show a file dialog';
      finish(() => reject(new Error(message)));
    });

    transport.post({
      id,
      type: 'pick',
      mode,
      title: opts.title,
      // A folder dialog has nothing to multi-select.
      multiple: mode === 'files' && opts.multiple === true,
    });
  });
}
