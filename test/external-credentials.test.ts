/**
 * Credentials supplied from outside the process, the 1Password `op run` shape.
 *
 * The point of these is what is *not* on disk: the server signs itself in from a secret the
 * operator's password manager lent it for this run, and the session file never gains a password.
 * Every test runs against a stub fetch, an in-memory keychain, and a stand-in for the `op` CLI —
 * nothing here reaches Fellow, the operator's keychain, or a real 1Password vault.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { FellowClient } from '@/fellow/client';
import {
  EMAIL_ENV,
  externalCredentialsConfigured,
  PASSWORD_ENV,
  readExternalCredentials,
  setSecretResolverForTests
} from '@/fellow/credentials';
import { type Keychain, setKeychainForTests } from '@/fellow/keychain';
import { SessionStore } from '@/fellow/session';
import { freshDataDir, withFetch } from './helpers/offline';

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

function token(name: string, expiresInMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor((Date.now() + expiresInMs) / 1000) }))
    .toString('base64')
    .replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.${name}`;
}

const EMAIL = 'someone@example.com';
const PASSWORD = 'from-the-vault-never-stored';
const REFERENCE = 'op://Private/Fellow/password';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch(routes: { refresh?: () => Response; login?: () => Response; devices?: () => Response }) {
  const calls: string[] = [];
  const bodies: string[] = [];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (typeof init?.body === 'string') bodies.push(init.body);

    if (url.includes('/auth/refresh')) return (routes.refresh ?? (() => json({}, 500)))();
    if (url.includes('/auth/login')) return (routes.login ?? (() => json({}, 500)))();
    if (url.includes('/devices')) return (routes.devices ?? (() => json([], 200)))();
    throw new Error(`unexpected request to ${url}`);
  }) as unknown as typeof fetch;

  return { fetchStub, bodies, count: (fragment: string) => calls.filter((c) => c.includes(fragment)).length };
}

/** A login route that hands back a working session, as Fellow would. */
function goodLogin() {
  return json({ accessToken: token('fresh', 3_600_000), refreshToken: 'refresh-token-2' });
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  freshDataDir();
  setKeychainForTests(memoryKeychain());
  saved[EMAIL_ENV] = process.env[EMAIL_ENV];
  saved[PASSWORD_ENV] = process.env[PASSWORD_ENV];
});

afterEach(() => {
  setKeychainForTests(undefined);
  setSecretResolverForTests(undefined);
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('reading the configured credentials', () => {
  test('an injected value is used as-is, without invoking the secret manager', async () => {
    process.env[PASSWORD_ENV] = PASSWORD;
    setSecretResolverForTests(() => {
      throw new Error('the op CLI must not be run for an already-resolved value');
    });

    expect(externalCredentialsConfigured()).toBe(true);
    expect(await readExternalCredentials(EMAIL)).toEqual({ email: EMAIL, password: PASSWORD });
  });

  test('an op:// reference is resolved through the CLI at the moment it is needed', async () => {
    process.env[PASSWORD_ENV] = REFERENCE;
    const asked: string[] = [];
    setSecretResolverForTests(async (reference) => {
      asked.push(reference);
      return PASSWORD;
    });

    expect(await readExternalCredentials(EMAIL)).toEqual({ email: EMAIL, password: PASSWORD });
    // The reference is a pointer, not the secret: resolving it is what keeps the value out of the
    // process environment until a re-login actually needs it.
    expect(asked).toEqual([REFERENCE]);
  });

  test('nothing configured reads as nothing, not as an error', async () => {
    delete process.env[PASSWORD_ENV];
    expect(externalCredentialsConfigured()).toBe(false);
    expect(await readExternalCredentials(EMAIL)).toBeNull();
  });

  test('a password with no account to use it on is a configuration error', async () => {
    process.env[PASSWORD_ENV] = PASSWORD;
    delete process.env[EMAIL_ENV];
    await expect(readExternalCredentials(undefined)).rejects.toThrow(EMAIL_ENV);
  });

  test('a resolver that returns nothing is refused rather than sent to Fellow', async () => {
    process.env[PASSWORD_ENV] = REFERENCE;
    setSecretResolverForTests(async () => '');
    await expect(readExternalCredentials(EMAIL)).rejects.toThrow(PASSWORD_ENV);
  });
});

describe('signing in from the environment', () => {
  test('a cold start with no session file signs itself in', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = REFERENCE;
    setSecretResolverForTests(async () => PASSWORD);
    const stub = stubFetch({ login: goodLogin, devices: () => json([{ id: 'dev-1' }]) });

    const devices = await withFetch(stub.fetchStub, () => new FellowClient().listDevices());

    expect(devices).toHaveLength(1);
    expect(stub.count('/auth/login')).toBe(1);
  });

  test('the password reaches Fellow but never the session file', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = PASSWORD;
    const stub = stubFetch({ login: goodLogin, devices: () => json([]) });

    await withFetch(stub.fetchStub, () => new FellowClient().listDevices());

    expect(stub.bodies.some((body) => body.includes(PASSWORD))).toBe(true);
    const stored = await new SessionStore().read();
    expect(stored?.accessToken).toBeTruthy();
    // The whole reason for this path: the long-lived credential stays in the vault.
    expect(stored?.password).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  test('a dead refresh token is recovered from the environment instead of the stored password', async () => {
    process.env[PASSWORD_ENV] = PASSWORD;
    await new SessionStore().write({
      email: EMAIL,
      accessToken: token('stale', -60_000),
      refreshToken: 'refresh-token-1',
      obtainedAtMs: Date.now() - 3_600_000,
      accessTokenExpMs: Date.now() - 60_000,
      password: 'the-remembered-one-should-not-be-used'
    });
    const stub = stubFetch({
      refresh: () => json({ message: 'invalid refresh token' }, 401),
      login: goodLogin,
      devices: () => json([])
    });

    await withFetch(stub.fetchStub, () => new FellowClient().listDevices());

    expect(stub.count('/auth/login')).toBe(1);
    expect(stub.bodies.some((body) => body.includes(PASSWORD))).toBe(true);
    expect(stub.bodies.some((body) => body.includes('the-remembered-one-should-not-be-used'))).toBe(false);
    // Re-login stores tokens only, so the pre-existing remembered password is cleared with it.
    expect((await new SessionStore().read())?.password).toBeUndefined();
  });

  test('parallel cold starts share one login rather than racing the refresh token', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = PASSWORD;
    const stub = stubFetch({ login: goodLogin, devices: () => json([]) });

    await withFetch(stub.fetchStub, async () => {
      const client = new FellowClient();
      await Promise.all([client.listDevices(), client.listDevices(), client.listDevices()]);
    });

    expect(stub.count('/auth/login')).toBe(1);
  });

  test('credentials Fellow rejects are tried once, not replayed into a lockout', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = PASSWORD;
    const stub = stubFetch({ login: () => json({ message: 'unauthorized' }, 401) });

    await withFetch(stub.fetchStub, async () => {
      const client = new FellowClient();
      await expect(client.listDevices()).rejects.toThrow(PASSWORD_ENV);
      // Latched: the next calls fail without touching Fellow again.
      await expect(client.listDevices()).rejects.toThrow();
      await expect(client.listDevices()).rejects.toThrow();
    });

    expect(stub.count('/auth/login')).toBe(1);
  });

  test('an unreachable Fellow is reported as retryable, and is retried', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = PASSWORD;
    let attempts = 0;
    const stub = stubFetch({
      login: () => {
        attempts += 1;
        return attempts === 1 ? json({ message: 'bad gateway' }, 502) : goodLogin();
      },
      devices: () => json([])
    });

    await withFetch(stub.fetchStub, async () => {
      const client = new FellowClient();
      await expect(client.listDevices()).rejects.toThrow(/retry in a moment/);
      // A 5xx says nothing about the credentials, so the next call tries again.
      await client.listDevices();
    });

    expect(attempts).toBe(2);
  });
});

describe('auth.status', () => {
  test('reports the environment as the source when one is configured', async () => {
    process.env[EMAIL_ENV] = EMAIL;
    process.env[PASSWORD_ENV] = REFERENCE;
    setSecretResolverForTests(() => {
      throw new Error('status must not spawn the op CLI');
    });

    const status = await new FellowClient().status();

    expect(status.autoReconnect).toBe(true);
    expect(status.autoReconnectSource).toBe('environment');
  });

  test('reports the stored password when that is all there is', async () => {
    delete process.env[PASSWORD_ENV];
    await new SessionStore().write({
      email: EMAIL,
      accessToken: token('live', 3_600_000),
      obtainedAtMs: Date.now(),
      password: 'remembered'
    });

    const status = await new FellowClient().status();

    expect(status.autoReconnectSource).toBe('stored-password');
  });

  test('reports no automatic reconnect when neither is present', async () => {
    delete process.env[PASSWORD_ENV];
    await new SessionStore().write({
      email: EMAIL,
      accessToken: token('live', 3_600_000),
      obtainedAtMs: Date.now()
    });

    const status = await new FellowClient().status();

    expect(status.autoReconnect).toBe(false);
    expect(status.autoReconnectSource).toBeUndefined();
  });
});
