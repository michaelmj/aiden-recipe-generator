/**
 * Session continuity: what happens between a stored session and a working request.
 *
 * The failure these cover is a user-visible one — "Session expired and refresh failed, run
 * `bun run auth:login` again" arriving while the credentials on disk were still perfectly good.
 * Every path runs against a stub fetch and an in-memory keychain; nothing here touches the network
 * or the operator's real credential store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FellowClient } from '@/fellow/client';
import { type Keychain, setKeychainForTests } from '@/fellow/keychain';
import { type Session, SessionStore } from '@/fellow/session';
import { freshDataDir, withFetch } from './helpers/offline';

/** An in-memory stand-in for the OS keychain, so the encrypted-session path is testable. */
function memoryKeychain(): Keychain {
  const items = new Map<string, string>();
  const key = (service: string, account: string) => `${service} ${account}`;
  return {
    async get(service, account) {
      return items.get(key(service, account)) ?? null;
    },
    async set(service, account, secret) {
      items.set(key(service, account), secret);
    },
    async delete(service, account) {
      return items.delete(key(service, account));
    }
  };
}

/** A JWT-shaped token whose exp claim the client can read. */
function token(name: string, expiresInMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }))
    .toString('base64')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.${name}`;
}

const EMAIL = 'someone@example.com';
const PASSWORD = 'remembered-password-never-logged';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A request log plus a router, so each test only describes the responses it cares about. */
function stubFetch(routes: { refresh?: () => Response; login?: () => Response; devices?: () => Response }) {
  const calls: string[] = [];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);

    if (url.includes('/auth/refresh')) return (routes.refresh ?? (() => json({}, 500)))();
    if (url.includes('/auth/login')) return (routes.login ?? (() => json({}, 500)))();
    if (url.includes('/devices')) return (routes.devices ?? (() => json([], 200)))();
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;

  return { fetchStub, calls, count: (fragment: string) => calls.filter((c) => c.includes(fragment)).length };
}

async function storeSession(overrides: Partial<Session> = {}) {
  await new SessionStore().write({
    email: EMAIL,
    accessToken: token('stale', -60_000),
    refreshToken: 'refresh-token-1',
    obtainedAtMs: Date.now() - 3_600_000,
    accessTokenExpMs: Date.now() - 60_000,
    ...overrides
  });
}

beforeEach(() => {
  freshDataDir();
  setKeychainForTests(memoryKeychain());
});

afterEach(() => setKeychainForTests(undefined));

describe('refreshing a spent access token', () => {
  test('refreshes before the request and stores the rotated refresh token', async () => {
    await storeSession();
    const fresh = token('fresh', 3_600_000);
    const stub = stubFetch({
      refresh: () => json({ accessToken: fresh, refreshToken: 'refresh-token-2' }),
      devices: () => json([])
    });

    await withFetch(stub.fetchStub, async () => {
      await new FellowClient().listDevices();
    });

    expect(stub.count('/auth/refresh')).toBe(1);
    const stored = await new SessionStore().read();
    expect(stored?.accessToken).toBe(fresh);
    // Fellow rotates the refresh token; keeping the spent one is what breaks the next refresh.
    expect(stored?.refreshToken).toBe('refresh-token-2');
  });

  test('a token rejected before its expiry is refreshed and the request retried', async () => {
    // Not spent by the clock: only Fellow's 401 reveals that it no longer works.
    await storeSession({ accessToken: token('live', 3_600_000), accessTokenExpMs: Date.now() + 3_600_000 });
    let deviceCalls = 0;
    const stub = stubFetch({
      refresh: () => json({ accessToken: token('fresh', 3_600_000) }),
      devices: () => {
        deviceCalls += 1;
        return deviceCalls === 1 ? json({ message: 'unauthorized' }, 401) : json([{ id: 'dev-1' }]);
      }
    });

    const devices = await withFetch(stub.fetchStub, () => new FellowClient().listDevices());

    expect(devices).toHaveLength(1);
    expect(stub.count('/auth/refresh')).toBe(1);
    expect(deviceCalls).toBe(2);
  });

  test('parallel calls share one refresh', async () => {
    await storeSession();
    const stub = stubFetch({
      refresh: () => json({ accessToken: token('fresh', 3_600_000), refreshToken: 'refresh-token-2' }),
      devices: () => json([])
    });

    await withFetch(stub.fetchStub, async () => {
      const client = new FellowClient();
      await Promise.all([client.listDevices(), client.listDevices(), client.listDevices()]);
    });

    // Three refreshes would spend the same rotating refresh token three times, and the last write
    // would store a token Fellow had already retired.
    expect(stub.count('/auth/refresh')).toBe(1);
  });
});

describe('when a refresh does not produce a token', () => {
  test('a network failure keeps the session and does not ask for a new login', async () => {
    await storeSession();
    const stub = (async (input: string | URL) => {
      if (String(input).includes('/auth/refresh')) throw new Error('ECONNRESET');
      return json([]);
    }) as unknown as typeof fetch;

    const err = await withFetch(stub, () =>
      new FellowClient()
        .listDevices()
        .then(() => null)
        .catch((e: Error) => e)
    );

    expect(err?.message).toMatch(/retry in a moment/);
    expect(err?.message).not.toMatch(/auth:login/);
    expect((await new SessionStore().read())?.refreshToken).toBe('refresh-token-1');
  });

  test('a 500 is retried, and a later success still serves the request', async () => {
    await storeSession();
    let attempts = 0;
    const stub = stubFetch({
      refresh: () => {
        attempts += 1;
        return attempts === 1 ? json({ message: 'boom' }, 500) : json({ accessToken: token('fresh', 3_600_000) });
      },
      devices: () => json([])
    });

    await withFetch(stub.fetchStub, () => new FellowClient().listDevices());
    expect(attempts).toBe(2);
  });

  test('a rejected refresh token asks for a new login, once', async () => {
    await storeSession();
    const stub = stubFetch({ refresh: () => json({ message: 'invalid_grant' }, 401) });

    const err = await withFetch(stub.fetchStub, () =>
      new FellowClient()
        .listDevices()
        .then(() => null)
        .catch((e: Error) => e)
    );

    expect(err?.message).toMatch(/auth:login/);
    // Terminal means terminal: no backoff loop against a credential Fellow will keep refusing.
    expect(stub.count('/auth/refresh')).toBe(1);
  });
});

describe('remembered password', () => {
  test('signs in again when the refresh token is gone', async () => {
    await storeSession({ password: PASSWORD, timezone: 'America/Detroit', refreshToken: undefined });
    const stub = stubFetch({
      login: () => json({ accessToken: token('fresh', 3_600_000), refreshToken: 'refresh-token-2' }),
      devices: () => json([{ id: 'dev-1' }])
    });

    const devices = await withFetch(stub.fetchStub, () => new FellowClient().listDevices());

    expect(devices).toHaveLength(1);
    expect(stub.count('/auth/login')).toBe(1);
    const stored = await new SessionStore().read();
    expect(stored?.refreshToken).toBe('refresh-token-2');
    // Still armed for next time, and the zone from the original login is replayed.
    expect(stored?.password).toBe(PASSWORD);
    expect(stored?.timezone).toBe('America/Detroit');
  });

  test('a password Fellow rejects is discarded rather than replayed', async () => {
    await storeSession({ password: PASSWORD, refreshToken: undefined });
    const stub = stubFetch({ login: () => json({ message: `bad password ${PASSWORD}` }, 401) });

    const err = await withFetch(stub.fetchStub, () =>
      new FellowClient()
        .listDevices()
        .then(() => null)
        .catch((e: Error) => e)
    );

    expect(err?.message).toMatch(/no longer works/);
    expect(err?.message).not.toContain(PASSWORD);
    expect((await new SessionStore().read())?.password).toBeUndefined();
  });

  test('is never written to the plaintext fallback file', async () => {
    // No keychain: the encrypted file is unavailable, so the password has nowhere safe to live.
    setKeychainForTests(null);
    process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION = '1';
    const warnings: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      warnings.push(args.join(' '));
    };
    try {
      await storeSession({ password: PASSWORD });
    } finally {
      console.error = realError;
      delete process.env.AIDEN_AI_ALLOW_PLAINTEXT_SESSION;
    }

    expect((await new SessionStore().read())?.password).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/remembered Fellow password was dropped/);
    expect(warnings.join(' ')).not.toContain(PASSWORD);
  });

  test('forgetPassword leaves the session signed in', async () => {
    await storeSession({ password: PASSWORD, accessTokenExpMs: Date.now() + 3_600_000 });
    await new FellowClient().forgetPassword();

    const stored = await new SessionStore().read();
    expect(stored?.password).toBeUndefined();
    expect(stored?.refreshToken).toBe('refresh-token-1');
    expect(await new FellowClient().status()).toMatchObject({ loggedIn: true, autoReconnect: false });
  });
});
