/**
 * Session Store - handles secure storage of Fellow credentials.
 *
 * The session blob is too large for the OS keychain helpers (see keychain.ts), so it is
 * kept in a 0600 file encrypted with AES-256-GCM under a data key that lives in the OS
 * keychain. Without a keychain the only option left is a plaintext file, so that path is refused
 * unless the operator opts in with AIDEN_AI_ALLOW_PLAINTEXT_SESSION, and warns on every write.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_ID, getAppDataDir } from '@/config';
import { getKeychain, type Keychain } from '@/fellow/keychain';

/** Stored Fellow session data */
export type Session = {
  email: string;
  accessToken: string;
  refreshToken?: string;
  obtainedAtMs: number;
  accessTokenExpMs?: number;
};

const KEYCHAIN_SERVICE = APP_ID;
/** Account holding the hex data key that encrypts the session file. */
const KEYCHAIN_ACCOUNT = 'fellow-session-key';

/** Encrypted session file (keychain available). */
function encryptedSessionPath() {
  return join(getAppDataDir(), 'session.enc.json');
}

/** Plaintext session file (no keychain helper, or a pre-encryption install). */
function sessionPath() {
  return join(getAppDataDir(), 'session.json');
}

/**
 * Opt-in required before credentials are written unencrypted.
 * Without a keychain helper the only fallback is a plaintext file, and silently writing an access
 * token and refresh token to disk is not a default anyone should get by accident.
 */
const PLAINTEXT_OPT_IN_ENV = 'AIDEN_AI_ALLOW_PLAINTEXT_SESSION';

function plaintextAllowed(): boolean {
  const value = process.env[PLAINTEXT_OPT_IN_ENV]?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** AES-256-GCM envelope written to disk. */
type Envelope = { v: 1; iv: string; tag: string; ct: string };

function isEnvelope(value: unknown): value is Envelope {
  const e = value as Partial<Envelope> | null;
  return !!e && e.v === 1 && typeof e.iv === 'string' && typeof e.tag === 'string' && typeof e.ct === 'string';
}

/** Read the data key from the keychain, creating one on first use. */
async function loadOrCreateKey(keychain: Keychain): Promise<Buffer> {
  const existing = await keychain.get(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (existing && /^[0-9a-f]{64}$/.test(existing)) return Buffer.from(existing, 'hex');

  const key = randomBytes(32);
  await keychain.set(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key.toString('hex'));
  return key;
}

function seal(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/** Decrypt an envelope; throws if the key is wrong or the file was tampered with. */
function unseal(key: Buffer, env: Envelope): string {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Read and JSON-parse a file, treating a missing file as null. */
async function readJson(path: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`Failed to read ${path}:`, (err as Error).message);
    }
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    console.error(`Failed to parse ${path}: not valid JSON`);
    return null;
  }
}

/**
 * Stores Fellow session securely.
 * Prefers the OS keychain (macOS Keychain via security(1), Linux Secret Service via
 * secret-tool(1)). With neither available, writing is refused unless
 * AIDEN_AI_ALLOW_PLAINTEXT_SESSION is set, in which case credentials go to a 0600 JSON file in
 * plaintext and every write says so.
 */
export class SessionStore {
  /** Read the session, decrypting it when a keychain data key is available */
  async read(): Promise<Session | null> {
    const keychain = await getKeychain();

    if (keychain) {
      const stored = await readJson(encryptedSessionPath());
      if (isEnvelope(stored)) {
        const key = await loadOrCreateKey(keychain);
        try {
          return JSON.parse(unseal(key, stored)) as Session;
        } catch (err) {
          console.error('Failed to decrypt session file; re-authentication required:', (err as Error).message);
          return null;
        }
      }
      // Fall through: a pre-encryption install may still have a plaintext file to migrate.
    }

    const plain = await readJson(sessionPath());
    if (plain === null) return null;
    const session = plain as Session;

    if (keychain) {
      // Migrate the legacy plaintext file to the encrypted one, then drop it.
      await this.write(session);
      await rm(sessionPath(), { force: true });
    }
    return session;
  }

  /** Write the session, encrypted under the keychain data key when one is available */
  async write(session: Session): Promise<void> {
    const keychain = await getKeychain();
    await mkdir(getAppDataDir(), { recursive: true });

    if (keychain) {
      const key = await loadOrCreateKey(keychain);
      const envelope = seal(key, JSON.stringify(session));
      await writeFile(encryptedSessionPath(), JSON.stringify(envelope), { mode: 0o600 });
      return;
    }

    if (!plaintextAllowed()) {
      throw new Error(
        'No OS keychain helper found, so the Fellow session could only be stored unencrypted. ' +
          'Refusing to write credentials in plaintext. On Linux install libsecret-tools ' +
          `(secret-tool) for encrypted storage, or set ${PLAINTEXT_OPT_IN_ENV}=1 to accept ` +
          'plaintext storage.'
      );
    }

    // Warned on every write, not once per process: this is the state of the credentials on disk,
    // not a one-off setup notice, and a long-lived server would otherwise say it once and never again.
    console.error(
      `WARNING: no OS keychain helper found and ${PLAINTEXT_OPT_IN_ENV} is set; storing Fellow credentials in plaintext at ${sessionPath()} (mode 0600).`
    );

    await writeFile(sessionPath(), JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  /** Clear the stored session and its data key */
  async clear(): Promise<void> {
    const keychain = await getKeychain();
    if (keychain) await keychain.delete(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);

    await rm(encryptedSessionPath(), { force: true });
    await rm(sessionPath(), { force: true });
  }
}

/** Decode JWT expiration timestamp (no verification, just reads exp claim) */
export function decodeJwtExpMs(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;

  const payloadB64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
  const pad = payloadB64.length % 4 === 0 ? '' : '='.repeat(4 - (payloadB64.length % 4));
  const payloadJson = Buffer.from(payloadB64 + pad, 'base64').toString('utf8');

  try {
    const payload = JSON.parse(payloadJson) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
