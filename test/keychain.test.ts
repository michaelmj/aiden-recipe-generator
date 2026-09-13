/**
 * Keychain backend tests.
 *
 * The round-trip tests talk to the real login keychain, which can raise a macOS access
 * dialog and block. They are opt-in: run with AIDEN_TEST_KEYCHAIN=1.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { getKeychain, MAX_SECRET_LENGTH } from '@/fellow/keychain';

const SERVICE = 'aiden-ai-profile-generator-test';
const ACCOUNT = `keychain-test-${process.pid}`;
const LIVE = process.env.AIDEN_TEST_KEYCHAIN === '1';

describe('getKeychain', () => {
  test('resolves a backend on macOS and caches it', async () => {
    const keychain = await getKeychain();
    if (process.platform === 'darwin') expect(keychain).not.toBeNull();
    expect(await getKeychain()).toBe(keychain);
  });
});

describe.if(LIVE)('keychain round-trip (AIDEN_TEST_KEYCHAIN=1)', () => {
  afterAll(async () => {
    (await getKeychain())?.delete(SERVICE, ACCOUNT);
  });

  test('stores, overwrites, reads back, and deletes a secret', async () => {
    const keychain = await getKeychain();
    if (!keychain) return;

    const secret = randomBytes(32).toString('hex');
    await keychain.set(SERVICE, ACCOUNT, secret);
    expect(await keychain.get(SERVICE, ACCOUNT)).toBe(secret);

    // Overwrite must replace, not create a second item.
    const updated = randomBytes(32).toString('hex');
    await keychain.set(SERVICE, ACCOUNT, updated);
    expect(await keychain.get(SERVICE, ACCOUNT)).toBe(updated);

    expect(await keychain.delete(SERVICE, ACCOUNT)).toBe(true);
    expect(await keychain.get(SERVICE, ACCOUNT)).toBeNull();
  });

  test('missing entries read as null and delete as false', async () => {
    const keychain = await getKeychain();
    if (!keychain) return;
    expect(await keychain.get(SERVICE, `absent-${process.pid}`)).toBeNull();
    expect(await keychain.delete(SERVICE, `absent-${process.pid}`)).toBe(false);
  });
});

describe('keychain input validation', () => {
  test('refuses a secret containing a newline', async () => {
    const keychain = await getKeychain();
    if (!keychain) return;
    await expect(keychain.set(SERVICE, ACCOUNT, 'line1\nline2')).rejects.toThrow(/newline/);
  });

  // security(1) reads its stdin prompt into a 128-char buffer and drops the rest silently,
  // so an over-long secret must fail loudly rather than store corrupt.
  test('refuses a secret longer than the helper can hold', async () => {
    const keychain = await getKeychain();
    if (!keychain) return;
    await expect(keychain.set(SERVICE, ACCOUNT, 'a'.repeat(MAX_SECRET_LENGTH + 1))).rejects.toThrow(/truncates/);
  });
});
