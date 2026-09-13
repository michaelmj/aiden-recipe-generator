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

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/** A newline would desync the macOS confirm prompt, which reads the secret twice. */
const SECRET_PATTERN = /^[^\n\r]+$/;

/**
 * macOS `security -w` reads its stdin prompt into a 128-character buffer and drops the
 * rest without complaint, so refuse anything that would be truncated.
 */
export const MAX_SECRET_LENGTH = 128;

/** Max bytes we accept from a helper's stdout, to bound a misbehaving child. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** How long a helper may run before we kill it. */
const HELPER_TIMEOUT_MS = 10_000;

export type Keychain = {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
};

type RunResult = { code: number; stdout: string; stderr: string };

/** Run a helper with no shell, feeding `input` on stdin and capturing stdout. */
function run(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: HELPER_TIMEOUT_MS,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        fail(new Error(`${command} produced more than ${MAX_OUTPUT_BYTES} bytes`));
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (signal) {
        reject(new Error(`${command} terminated with ${signal}`));
        return;
      }
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });

    child.stdin.on('error', () => {
      // Helper closed stdin early (e.g. it found nothing to prompt for); the exit code decides.
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

/** True if `command` resolves on PATH. */
async function onPath(command: string): Promise<boolean> {
  try {
    const { code } = await run('/usr/bin/env', ['which', command]);
    return code === 0;
  } catch {
    return false;
  }
}

function assertStorable(secret: string): void {
  if (!SECRET_PATTERN.test(secret)) {
    throw new Error('Refusing to store an empty secret, or one containing a newline, in the OS keychain');
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new Error(
      `Refusing to store a ${secret.length}-character secret: the OS keychain helper truncates at ${MAX_SECRET_LENGTH}`,
    );
  }
}

/** macOS Keychain via security(1). Exit code 44 means "no such item". */
const macKeychain: Keychain = {
  async get(service, account) {
    const { code, stdout } = await run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (code === 44) return null;
    if (code !== 0) throw new Error(`security find-generic-password failed (exit ${code})`);
    // -w prints the password followed by a newline.
    return stdout.replace(/\r?\n$/, '');
  },

  async set(service, account, secret) {
    assertStorable(secret);
    // With -w and no value, security prompts for the password twice on stdin.
    const { code } = await run('security', ['add-generic-password', '-s', service, '-a', account, '-U', '-w'], `${secret}\n${secret}\n`);
    if (code !== 0) throw new Error(`security add-generic-password failed (exit ${code})`);
  },

  async delete(service, account) {
    const { code } = await run('security', ['delete-generic-password', '-s', service, '-a', account]);
    if (code === 44) return false;
    if (code !== 0) throw new Error(`security delete-generic-password failed (exit ${code})`);
    return true;
  },
};

/** Linux Secret Service via secret-tool(1). Exit code 1 from lookup/clear means "no such item". */
const secretToolKeychain: Keychain = {
  async get(service, account) {
    const { code, stdout } = await run('secret-tool', ['lookup', 'service', service, 'account', account]);
    if (code !== 0) return null;
    if (stdout === '') return null;
    return stdout.replace(/\r?\n$/, '');
  },

  async set(service, account, secret) {
    assertStorable(secret);
    const { code } = await run(
      'secret-tool',
      ['store', '--label', `${service} (${account})`, 'service', service, 'account', account],
      secret,
    );
    if (code !== 0) throw new Error(`secret-tool store failed (exit ${code})`);
  },

  async delete(service, account) {
    const { code } = await run('secret-tool', ['clear', 'service', service, 'account', account]);
    return code === 0;
  },
};

/** Cached backend: `null` once we know this platform has none. */
let cache: Keychain | null | undefined;

/** Resolve the OS keychain backend, or null when this platform has no usable one. */
export async function getKeychain(): Promise<Keychain | null> {
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
