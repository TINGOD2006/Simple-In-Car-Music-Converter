/**
 * `api.pick` has three routes to a file dialog, and the order matters:
 *
 *   1. the page's native bridge (the desktop shell — returns real engine paths),
 *   2. the engine's own `POST /api/pick` (a plain browser on Windows),
 *   3. nothing — which the UI turns into an upload.
 *
 * Both inputs are injected, so all three routes and every combination are
 * exercised here without a browser, without a shell, and without a server.
 */

import { assert, assertEq, test } from './harness.ts';
import {
  api,
  isNoNativeDialog,
  NO_NATIVE_DIALOG,
  type FetchLike,
} from '../web/src/api.ts';
import type { NativeTransport } from '../web/src/native-bridge.ts';

/** The slice of `Response` the api module actually reads. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

/** A `fetch` that records which URLs were asked for and answers from a table. */
function fetchSpy(routes: Record<string, () => Response | Promise<Response>>): {
  fetchImpl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const handler = routes[url];
    if (!handler) throw new Error(`unexpected fetch: ${url}`);
    return handler();
  };
  return { fetchImpl, calls };
}

/** A bridge that answers each post the way `answer` says; `undefined` = silence. */
function bridgeAnswering(
  answer: (message: Record<string, unknown>) => unknown,
): NativeTransport {
  const handlers = new Set<(data: unknown) => void>();
  return {
    post(message: unknown) {
      const m = message as Record<string, unknown>;
      const reply = answer(m);
      if (reply !== undefined) {
        queueMicrotask(() => {
          for (const h of handlers) h(reply);
        });
      }
    },
    subscribe(handler: (data: unknown) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}

test('api-pick: the native bridge wins and the engine is never asked', async () => {
  const bridge = bridgeAnswering((m) => ({ id: m.id, ok: true, paths: ['C:\\bridge.mp3'] }));
  const spy = fetchSpy({});
  const res = await api.pick({ mode: 'files' }, { transport: bridge, fetchImpl: spy.fetchImpl });
  assertEq(res.paths, ['C:\\bridge.mp3'], 'the bridged path comes back');
  assertEq(spy.calls.length, 0, 'the engine was not asked');
});

test('api-pick: a cancelled bridge is an empty path list, not an error', async () => {
  const bridge = bridgeAnswering((m) => ({ id: m.id, cancelled: true }));
  const spy = fetchSpy({});
  const res = await api.pick({ mode: 'folder' }, { transport: bridge, fetchImpl: spy.fetchImpl });
  assertEq(res.ok, true, 'cancelling is still a successful call');
  assertEq(res.paths, [], 'cancelling reports no paths');
  assertEq(spy.calls.length, 0, 'the engine was not asked');
});

test('api-pick: without a bridge the engine dialog is used', async () => {
  const spy = fetchSpy({
    '/api/pick': () => jsonResponse(200, { ok: true, paths: ['C:\\engine.mp3'] }),
  });
  const res = await api.pick({ mode: 'files' }, { transport: null, fetchImpl: spy.fetchImpl });
  assertEq(res.paths, ['C:\\engine.mp3'], 'the engine path comes back');
  assertEq(spy.calls, ['/api/pick'], 'the engine route was used exactly once');
});

test('api-pick: a broken bridge still falls back to the engine', async () => {
  const bridge = bridgeAnswering((m) => ({ id: m.id, ok: false, error: 'host exploded' }));
  const spy = fetchSpy({
    '/api/pick': () => jsonResponse(200, { ok: true, paths: ['C:\\engine.mp3'] }),
  });
  const res = await api.pick({ mode: 'files' }, { transport: bridge, fetchImpl: spy.fetchImpl });
  assertEq(res.paths, ['C:\\engine.mp3'], 'the fallback really happens');
  assertEq(spy.calls.length, 1, 'the engine was asked after the bridge failed');
});

test('api-pick: no bridge and a 501 is reported as NO_NATIVE_DIALOG', async () => {
  const spy = fetchSpy({
    '/api/pick': () => jsonResponse(501, { ok: false, error: 'no native dialog on this platform' }),
  });
  let caught: unknown = null;
  try {
    await api.pick({ mode: 'files' }, { transport: null, fetchImpl: spy.fetchImpl });
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, 'it must reject when no route works');
  assert(isNoNativeDialog(caught), `the UI must recognise this as "no dialog" (got ${String(caught)})`);
  assert(
    (caught as Error).message.includes(NO_NATIVE_DIALOG),
    'the message names the condition so the banner is actionable',
  );
});

test('api-pick: a broken bridge plus a 501 is also NO_NATIVE_DIALOG', async () => {
  const bridge = bridgeAnswering((m) => ({ id: m.id, ok: false, error: 'host exploded' }));
  const spy = fetchSpy({
    '/api/pick': () => jsonResponse(501, { ok: false, error: 'none' }),
  });
  let caught: unknown = null;
  try {
    await api.pick({ mode: 'files' }, { transport: bridge, fetchImpl: spy.fetchImpl });
  } catch (err) {
    caught = err;
  }
  assert(isNoNativeDialog(caught), 'both routes failing is still "no dialog"');
});
