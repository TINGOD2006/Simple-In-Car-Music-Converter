/**
 * The native bridge replaces the engine's POST /api/pick when the page runs
 * inside the desktop shell. `bridgePick` takes its transport as an argument, so
 * every branch — success, cancel, error, timeout, and two picks in flight at
 * once — is exercised here without a browser and without a WebView2 host.
 */

import { assert, assertEq, test } from './harness.ts';
import {
  BRIDGE_TIMEOUT_CODE,
  BridgeTimeoutError,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  bridgePick,
  detectNativeTransport,
  isBridgeTimeout,
  type NativeTransport,
} from '../web/src/native-bridge.ts';

interface FakeTransport extends NativeTransport {
  readonly sent: Array<Record<string, unknown>>;
}

/**
 * A transport that answers each `post` the way `answer` says. Returning
 * `undefined` means "never answer", which is how the timeout branch is reached.
 */
function fakeTransport(answer: (message: Record<string, unknown>) => unknown): FakeTransport {
  const handlers = new Set<(data: unknown) => void>();
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    post(message: unknown) {
      const m = message as Record<string, unknown>;
      sent.push(m);
      const reply = answer(m);
      if (reply !== undefined) {
        // Answer on a later tick, the way a real host does: a host that answers
        // synchronously would hide a subscriber registered after `post`.
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

/** `assertThrows` is synchronous; the bridge rejects asynchronously. */
async function assertRejects(
  fn: () => Promise<unknown>,
  needle: string,
  msg: string,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const text = (err as Error).message ?? String(err);
    assert(text.includes(needle), `${msg} (message was: ${text})`);
    return;
  }
  throw new Error(`Expected a rejection: ${msg}`);
}

test('native-bridge: a plain object has no transport', () => {
  assertEq(detectNativeTransport({}), null, 'a browser-less scope reports no transport');
});

test('native-bridge: chrome.webview is detected as a transport', () => {
  const scope = {
    chrome: {
      webview: {
        postMessage: () => {},
        addEventListener: () => {},
      },
    },
  };
  const transport = detectNativeTransport(scope);
  assert(transport !== null, 'the WebView2 host object is recognised');
  assert(typeof transport!.post === 'function', 'the transport exposes post');
  assert(typeof transport!.subscribe === 'function', 'the transport exposes subscribe');
});

test('native-bridge: an answer with paths resolves to those paths', async () => {
  const transport = fakeTransport((m) => ({ id: m.id, ok: true, paths: ['C:\\a.mp3'] }));
  const paths = await bridgePick(transport, 'files');
  assertEq(paths, ['C:\\a.mp3'], 'the picked path comes back');
  assertEq(transport.sent.length, 1, 'exactly one request was posted');
  assertEq(transport.sent[0]!.type, 'pick', 'the request is a pick');
  assertEq(transport.sent[0]!.mode, 'files', 'the request carries the mode');
});

test('native-bridge: the reply the SHELL actually writes must be accepted', async () => {
  // The literal JSON strings desktop/Bridge.cs emits, parsed the way WebView2 hands them
  // to the page. Written out in full because this seam is where the two sides drifted:
  // the shell answered a finished pick with `id`+`paths` while this file required
  // `ok:true`, so every success was read as a broken bridge and the caller opened the
  // engine's folder dialog on top of the shell's — the second "Browse For Folder" window.
  const wire = (id: unknown, body: string): unknown => JSON.parse(`{"id":"${String(id)}"${body}}`);

  const success = fakeTransport((m) => wire(m.id, ',"ok":true,"paths":["C:\\\\music\\\\a.mp3"]'));
  assertEq(await bridgePick(success, 'folder'), ['C:\\music\\a.mp3'], 'ok:true plus paths resolves');

  // The shape the shipped shell used to write. It has to keep working: the page ships with
  // the engine, but a user's installed shell is whatever build they already have.
  const legacy = fakeTransport((m) => wire(m.id, ',"paths":["C:\\\\music\\\\a.mp3"]'));
  assertEq(await bridgePick(legacy, 'folder'), ['C:\\music\\a.mp3'], 'paths without ok still resolves');

  const cancel = fakeTransport((m) => wire(m.id, ',"ok":false,"cancelled":true'));
  assertEq(await bridgePick(cancel, 'folder'), null, 'a cancellation is not an error');

  const failure = fakeTransport((m) =>
    wire(m.id, ',"ok":false,"error":"no native file dialog is available here"'),
  );
  await assertRejects(
    () => bridgePick(failure, 'folder'),
    'no native file dialog is available here',
    'a host that cannot show one still reports its reason',
  );
});

test('native-bridge: a cancellation resolves to null, not an error', async () => {
  const transport = fakeTransport((m) => ({ id: m.id, cancelled: true }));
  assertEq(await bridgePick(transport, 'files'), null, 'cancelling is a normal result');
});

test('native-bridge: a host error rejects with the host message', async () => {
  const transport = fakeTransport((m) => ({ id: m.id, ok: false, error: 'x' }));
  await assertRejects(() => bridgePick(transport, 'files'), 'x', 'the host message survives');
});

test('native-bridge: silence from the host rejects with a timeout', async () => {
  const transport = fakeTransport(() => undefined);
  await assertRejects(
    () => bridgePick(transport, 'files', { timeoutMs: 50 }),
    'timeout',
    'a host that never answers must not hang the UI',
  );
});

test('native-bridge: a timeout is distinguishable from a host that cannot help', async () => {
  // The distinction is what stops one pick from opening two folder windows: a
  // host that HAS NOT answered probably still has a dialog open, while a host
  // that answers "I cannot show one" is a reason to try the engine's dialog.
  const transport = fakeTransport(() => undefined);
  let caught: unknown = null;
  try {
    await bridgePick(transport, 'folder', { timeoutMs: 40 });
  } catch (err) {
    caught = err;
  }
  assert(caught !== null, 'silence from the host rejects');
  assert(isBridgeTimeout(caught), 'the timeout carries its own marker');
  assertEq((caught as BridgeTimeoutError).code, BRIDGE_TIMEOUT_CODE, 'the marker is the exported code');

  assert(
    !isBridgeTimeout(new Error('the desktop shell could not show a file dialog')),
    'an ordinary host error is not a timeout',
  );
});

test('native-bridge: the default wait outlasts someone browsing a full USB stick', () => {
  // It was two minutes, which fired on people who were simply still looking. The
  // retry that followed is what put a second folder window on top of the first.
  assert(
    DEFAULT_BRIDGE_TIMEOUT_MS >= 10 * 60_000,
    `the bridge must wait at least ten minutes (was ${DEFAULT_BRIDGE_TIMEOUT_MS}ms)`,
  );
});

test('native-bridge: two picks in flight keep their own answers', async () => {
  const transport = fakeTransport((m) => ({
    id: m.id,
    ok: true,
    paths: [m.mode === 'files' ? 'C:\\files.mp3' : 'C:\\folder'],
  }));
  const [files, folder] = await Promise.all([
    bridgePick(transport, 'files'),
    bridgePick(transport, 'folder'),
  ]);
  assertEq(files, ['C:\\files.mp3'], 'the files pick gets the files answer');
  assertEq(folder, ['C:\\folder'], 'the folder pick gets the folder answer');
  assertEq(transport.sent.length, 2, 'both requests were posted');
  assert(transport.sent[0]!.id !== transport.sent[1]!.id, 'each request carries its own id');
});
