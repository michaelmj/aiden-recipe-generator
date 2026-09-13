import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SHEET_MAX_BYTES } from '@/config';
import { SheetProfileStore } from '@/sheet/store';

const URL_OK = 'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=0';

/** Run sync() against a stubbed fetch, with a fresh HOME so nothing touches the real cache. */
async function syncWith(
  responder: (signal: AbortSignal) => Response,
  opts?: { timeoutMs?: number }
) {
  process.env.AIDEN_AI_DATA_DIR = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL, init?: RequestInit) =>
    responder(init?.signal as AbortSignal)) as typeof fetch;
  try {
    return await new SheetProfileStore({ csvUrl: URL_OK, ...opts }).sync({});
  } finally {
    globalThis.fetch = realFetch;
  }
}

function csvResponse(body: BodyInit) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/csv' } });
}

describe('sheet fetch bounds', () => {
  test('a body past the byte cap is aborted, not buffered', async () => {
    const chunk = new Uint8Array(256 * 1024).fill(0x61); // 'a'
    let served = 0;

    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        served += chunk.byteLength;
        controller.enqueue(chunk);
      }
    });

    await expect(syncWith(() => csvResponse(endless))).rejects.toThrow(/exceeded the \d+ byte limit/i);
    // Stopped near the cap rather than reading on. Exact stop point depends on how far the
    // stream buffers ahead, so the guard is "same order as the cap", not an exact byte count.
    expect(served).toBeLessThan(SHEET_MAX_BYTES * 2);
  });

  test('a declared Content-Length over the cap is refused before reading', async () => {
    const res = new Response('Title,x', {
      status: 200,
      headers: { 'content-type': 'text/csv', 'content-length': String(SHEET_MAX_BYTES + 1) }
    });
    await expect(syncWith(() => res)).rejects.toThrow(/over the \d+ byte limit/i);
  });

  test('a response that never finishes aborts at the timeout', async () => {
    const stalled = (signal: AbortSignal) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('Title,'));
          signal.addEventListener('abort', () => controller.error(signal.reason));
        }
      });

    await expect(syncWith((signal) => csvResponse(stalled(signal)), { timeoutMs: 50 })).rejects.toThrow();
  });

  test('an HTML error page is rejected instead of parsed as CSV', async () => {
    const html = new Response('<html><body>Sign in to continue</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
    await expect(syncWith(() => html)).rejects.toThrow(/expected one of text\/csv/i);
  });

  test('a missing Content-Type is rejected', async () => {
    await expect(syncWith(() => new Response('Title,x', { status: 200 }))).rejects.toThrow(/unknown/i);
  });

  test('text/plain with a charset still parses', async () => {
    const csv = 'Coffee,Demo\nOrigin,Ethiopia\nRoast,Light\n';
    const res = new Response(csv, { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    await expect(syncWith(() => res)).resolves.toMatchObject({ ok: true });
  });
});
