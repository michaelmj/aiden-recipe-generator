/**
 * Access control for the loopback HTTP entry (aiden-recipe-generator-m6i.2).
 *
 * Binding 127.0.0.1 keeps the LAN out, but not other local processes, and not browser pages:
 * a page on any site can rebind its own hostname to 127.0.0.1 and post to the port. These tools
 * drive the brewer with the user's Fellow session, so every request must pass two gates:
 *
 * 1. Host/Origin (403): Host must name the loopback listener exactly, and an Origin, when a
 *    browser sends one, must be that same loopback origin. This is what defeats DNS rebinding.
 * 2. Bearer token (401): a random token generated on each start, written 0600 to the app data
 *    dir, compared in constant time. Only processes that can read the user's files can call.
 *
 * The token is never logged; only its file path is.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';

import { getAppDataDir, MCP_HTTP_HOST } from '@/config';

/** File the per-start token is written to, inside the app data dir. */
export const HTTP_TOKEN_FILENAME = 'http-token';

export function httpTokenPath(): string {
  return join(getAppDataDir(), HTTP_TOKEN_FILENAME);
}

/** 256 bits of randomness, URL-safe so it drops into a header unescaped. */
export function generateHttpToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Write the token to the app data dir with mode 0600, replacing any token from a previous start.
 * Written to a 0600 temp file and renamed, so the file is never briefly world-readable and a
 * reader never sees half a token.
 */
export async function writeHttpTokenFile(token: string): Promise<string> {
  const dir = getAppDataDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = httpTokenPath();
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, `${token}\n`, { mode: 0o600 });
    // writeFile's mode is filtered through the umask; pin it explicitly.
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
  return path;
}

export class AccessDenied extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string
  ) {
    super(message);
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Host header values the listener answers to. */
export function allowedHosts(port: number): string[] {
  return [`${MCP_HTTP_HOST}:${port}`, `localhost:${port}`];
}

/** Origins a browser-originated request may carry. */
export function allowedOrigins(port: number): string[] {
  return allowedHosts(port).map((host) => `http://${host}`);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time compare that does not leak the expected token's length. */
function tokensMatch(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Throw AccessDenied unless the request passes the Host/Origin and bearer checks.
 * Host/Origin runs first: a rebinding page gets 403 whether or not it guessed a token.
 */
export function assertAuthorized(req: IncomingMessage, port: number, token: string): void {
  const host = header(req, 'host')?.toLowerCase();
  if (!host || !allowedHosts(port).includes(host)) {
    throw new AccessDenied(403, 'Forbidden: unexpected Host header');
  }

  const origin = header(req, 'origin');
  if (origin !== undefined && !allowedOrigins(port).includes(origin.toLowerCase())) {
    throw new AccessDenied(403, 'Forbidden: unexpected Origin header');
  }

  const auth = header(req, 'authorization') ?? '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  if (!match?.[1] || !tokensMatch(match[1], token)) {
    throw new AccessDenied(401, 'Unauthorized: missing or invalid bearer token');
  }
}
