/**
 * Credential hygiene: nothing thrown or logged may carry an upstream body, a token, or a password,
 * and credentials never land on disk unencrypted without an explicit opt-in.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FellowClient } from '@/fellow/client';
import { type Session, SessionStore } from '@/fellow/session';

const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.SUPERSECRETTOKEN.sig';
const SECRET_PASSWORD = 'hunter2-not-in-logs';

const SESSION: Session = {
  email: 'someone@example.com',
  accessToken: SECRET_TOKEN,
  refreshToken: 'refresh-SUPERSECRET',
  obtainedAtMs: Date.now()
};

function tempDataDir() {
  process.env.AIDEN_AI_DATA_DIR = mkdtempSync(join(tmpdir(), 'aiden-test-'));
  return process.env.AIDEN_AI_DATA_DIR;
}

/** Swap in a stub fetch for the duration of `body`. */
async function withFetch<T>(stub: typeof fetch, body: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
  }
}

afterEach(() => {
  delete process.env.AIDEN_AI_DISABLE_KEYCHAIN;
  delete process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION;
});

describe('upstream error bodies', () => {
  test('a failed login does not quote the response body', async () => {
    tempDataDir();
    // A real Fellow error body can echo the submitted credentials straight back.
    const leaky = `{"message":"bad password ${SECRET_PASSWORD} for token ${SECRET_TOKEN}"}`;
    const stub = (async () => new Response(leaky, { status: 401 })) as typeof fetch;

    await withFetch(stub, async () => {
      const client = new FellowClient();
      const err = await client
        .login({ email: 'someone@example.com', password: SECRET_PASSWORD, timezone: 'UTC' })
        .then(() => null)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).not.toContain(SECRET_PASSWORD);
      expect(err?.message).not.toContain(SECRET_TOKEN);
      expect(err?.message).not.toContain('bad password');
      expect(err?.message).toContain('401');
    });
  });

  test('a failed API call reports the status without the body', async () => {
    tempDataDir();
    // Plaintext session on purpose: this test must not touch the developer's real OS keychain.
    process.env.AIDEN_AI_DISABLE_KEYCHAIN = '1';
    process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';
    const store = new SessionStore();
    await store.write({ ...SESSION, accessTokenExpMs: Date.now() + 60 * 60 * 1000 });

    const leaky = `{"error":"token ${SECRET_TOKEN} rejected","stack":"internal detail"}`;
    const stub = (async () => new Response(leaky, { status: 500 })) as typeof fetch;

    await withFetch(stub, async () => {
      const err = await new FellowClient()
        .listDevices()
        .then(() => null)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      expect(err?.message).not.toContain(SECRET_TOKEN);
      expect(err?.message).not.toContain('internal detail');
      expect(err?.message).toMatch(/GET \/devices failed \(500\)/);
    });
  });
});

describe('plaintext session fallback', () => {
  test('refuses to write credentials unencrypted without the opt-in', async () => {
    const dir = tempDataDir();
    process.env.AIDEN_AI_DISABLE_KEYCHAIN = '1';

    await expect(new SessionStore().write(SESSION)).rejects.toThrow(/AIDEN_AI_ALLOW_PLAINTEXT_SESSION/);
    expect(existsSync(join(dir, 'session.json'))).toBe(false);
  });

  test('writes plaintext only with the opt-in, and warns on every write', async () => {
    const dir = tempDataDir();
    process.env.AIDEN_AI_DISABLE_KEYCHAIN = '1';
    process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';

    const warnings: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      const store = new SessionStore();
      await store.write(SESSION);
      await store.write(SESSION);
    } finally {
      console.error = realError;
    }

    // Every write warns: a long-lived server must not say this once and then go quiet.
    expect(warnings.filter((w) => w.includes('plaintext'))).toHaveLength(2);
    // The warning names the path and the opt-in, never the credentials themselves.
    expect(warnings.join(' ')).not.toContain(SECRET_TOKEN);

    const onDisk = readFileSync(join(dir, 'session.json'), 'utf8');
    expect(JSON.parse(onDisk)).toMatchObject({ email: SESSION.email });
  });
});
