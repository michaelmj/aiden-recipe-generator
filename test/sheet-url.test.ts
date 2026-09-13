import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertAllowedSheetUrl, DisallowedSheetUrlError } from '@/sheet/url';

const GOOD = 'https://docs.google.com/spreadsheets/d/abc/export?format=csv&gid=0';

afterEach(() => {
  delete process.env.AIDEN_AI_SHEET_ALLOWED_HOSTS;
});

describe('assertAllowedSheetUrl', () => {
  test('accepts the community sheet host', () => {
    expect(assertAllowedSheetUrl(GOOD).hostname).toBe('docs.google.com');
  });

  test('rejects targets an injected instruction would reach for', () => {
    const blocked = [
      'http://docs.google.com/x.csv', // downgrade to plaintext
      'https://169.254.169.254/latest/meta-data/', // cloud metadata
      'https://127.0.0.1:8080/admin',
      'https://localhost/secrets.csv',
      'https://evil.example/sheet.csv',
      'https://docs.google.com.evil.example/sheet.csv', // suffix lookalike
      'https://user:pass@docs.google.com/x.csv', // credentialed
      'file:///etc/passwd',
      'not a url'
    ];
    for (const url of blocked) {
      expect(() => assertAllowedSheetUrl(url)).toThrow(DisallowedSheetUrlError);
    }
  });

  test('operators can add a host through the environment', () => {
    expect(() => assertAllowedSheetUrl('https://sheets.internal/x.csv')).toThrow();
    process.env.AIDEN_AI_SHEET_ALLOWED_HOSTS = 'sheets.internal, other.example';
    expect(assertAllowedSheetUrl('https://sheets.internal/x.csv').hostname).toBe('sheets.internal');
  });
});

describe('redirect handling', () => {
  async function syncWith(responder: (url: string) => Response) {
    process.env.HOME = mkdtempSync(join(tmpdir(), 'aiden-test-'));
    const { SheetProfileStore } = await import('@/sheet/store');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => responder(String(input))) as typeof fetch;
    try {
      return await new SheetProfileStore({ csvUrl: GOOD }).sync({});
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test('refuses a redirect that leaves the allowlist', async () => {
    await expect(
      syncWith(() => new Response(null, { status: 302, headers: { location: 'https://evil.example/x.csv' } }))
    ).rejects.toThrow(/not an allowed sheet host/i);
  });

  test('an off-allowlist operator URL is still refused', async () => {
    process.env.AIDEN_AI_SHEET_CSV_URL = 'https://evil.example/sheet.csv';
    try {
      process.env.HOME = mkdtempSync(join(tmpdir(), 'aiden-test-'));
      const { SheetProfileStore } = await import('@/sheet/store');
      await expect(new SheetProfileStore().sync({})).rejects.toThrow(/not an allowed sheet host/i);
    } finally {
      delete process.env.AIDEN_AI_SHEET_CSV_URL;
    }
  });

  test('stops after too many redirects', async () => {
    await expect(
      syncWith((url) => new Response(null, { status: 302, headers: { location: `${url}&hop=1` } }))
    ).rejects.toThrow(/exceeded .* redirects/i);
  });
});
