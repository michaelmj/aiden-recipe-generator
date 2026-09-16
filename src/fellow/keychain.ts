/**
 * OS keychain access via the platform's own credential CLI.
 *
 * Replaces the archived `keytar` native module (see docs/DEPENDENCIES.md): no native
 * build, no install-time binary download, no extra dependencies. The secret is always
 * passed over stdin, never in argv, so it is not visible to `ps`.
 *
 * Backends:
 *   - macOS: `security` generic passwords (ships with the OS)
 *   - Linux: `secret-tool` (libsecret) when present on PATH
 *   - otherwise: unavailable, and the caller falls back to a 0600 file
 *
 * Small secrets only. `security`'s stdin password prompt silently truncates at 128
 * characters, so anything longer is rejected here rather than stored corrupt. Callers
 * with a larger payload should keep a data key here and encrypt the payload with it
 * (see `src/fellow/session.ts`).
 */

import { platform } from 'node:os';
import { onPath, runHelper } from '@/proc';

/** A newline would desync the macOS confirm prompt, which reads the secret twice. */
const SECRET_PATTERN = /^[^\n\r]+$/;

/**
 * macOS `security -w` reads its stdin prompt into a 128-character buffer and drops the
 * rest without complaint, so refuse anything that would be truncated.
 */
export const MAX_SECRET_LENGTH = 128;

export type Keychain = {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
};

function assertStorable(secret: string): void {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error('Refusing to store an empty secret, or one containing a newline, in the OS keychain');
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new Error(
      `Refusing to store a ${secret.length}-character secret: the OS keychain helper truncates at ${MAX_SECRET_LENGTH}`
    );
  }
}

/** macOS Keychain via security(1). Exit code 44 means "no such item". */
const macKeychain: Keychain = {
  async get(service, account) {
    const { code, stdout } = await runHelper('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (code === 44) return null;
    if (code !== 0) throw new Error(`security find-generic-password failed (exit ${code})`);
    // -w prints the password followed by a newline.
    return stdout.replace(/\r?\n$/, '');
  },

  async set(service, account, secret) {
    assertStorable(secret);
    // With -w and no value, security prompts for the password twice on stdin.
    const { code } = await runHelper(
      'security',
      ['add-generic-password', '-s', service, '-a', account, '-U', '-w'],
      `${secret}\n${secret}\n`
    );
    if (code !== 0) throw new Error(`security add-generic-password failed (exit ${code})`);
  },

  async delete(service, account) {
    const { code } = await runHelper('security', ['delete-generic-password', '-s', service, '-a', account]);
    if (code === 44) return false;
    if (code !== 0) throw new Error(`security delete-generic-password failed (exit ${code})`);
    return true;
  }
};

/** Linux Secret Service via secret-tool(1). Exit code 1 from lookup/clear means "no such item". */
const secretToolKeychain: Keychain = {
  async get(service, account) {
    const { code, stdout } = await runHelper('secret-tool', ['lookup', 'service', service, 'account', account]);
    if (code !== 0) return null;
    if (stdout === '') return null;
    return stdout.replace(/\r?\n$/, '');
  },

  async set(service, account, secret) {
    assertStorable(secret);
    const { code } = await runHelper(
      'secret-tool',
      ['store', '--label', `${service} (${account})`, 'service', service, 'account', account],
      secret
    );
    if (code !== 0) throw new Error(`secret-tool store failed (exit ${code})`);
  },

  async delete(service, account) {
    const { code } = await runHelper('secret-tool', ['clear', 'service', service, 'account', account]);
    return code === 0;
  }
};

/** Cached backend: `null` once we know this platform has none. */
let cache: Keychain | null | undefined;

/**
 * Test seam: a backend supplied by a test, which wins over probing and over the disable env var.
 * The encrypted-session path is only reachable with a keychain, and the test suite must never touch
 * the operator's real one, so tests install an in-memory stand-in here.
 */
let override: Keychain | null | undefined;

/** Install (or with `undefined`, remove) the test backend. */
export function setKeychainForTests(keychain: Keychain | null | undefined): void {
  override = keychain;
}

/** Resolve the OS keychain backend, or null when this platform has no usable one. */
export async function getKeychain(): Promise<Keychain | null> {
  if (override !== undefined) return override;

  // Opt-out seam: forces the no-keychain path without uninstalling the helper. Storing a session
  // then also needs AIDEN_AI_ALLOW_PLAINTEXT_SESSION, so this alone cannot silently downgrade
  // anyone to plaintext credentials.
  if (process.env.AIDEN_AI_DISABLE_KEYCHAIN === '1') return null;

  if (cache !== undefined) return cache;

  if (platform() === 'darwin' && (await onPath('security'))) {
    cache = macKeychain;
  } else if (platform() === 'linux' && (await onPath('secret-tool'))) {
    cache = secretToolKeychain;
  } else {
    cache = null;
  }

  return cache;
}

/** Test seam: forget the cached backend so the next call re-probes. */
export function resetKeychainCache(): void {
  cache = undefined;
}
