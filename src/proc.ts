/**
 * Bounded child-process helper.
 *
 * Two places here shell out to a local credential CLI — the OS keychain helpers
 * (`src/fellow/keychain.ts`) and the 1Password CLI (`src/fellow/credentials.ts`) — and both are
 * talking to a program that can prompt, hang, or flood stdout. Every call therefore runs with no
 * shell, a hard timeout, and a cap on how much output it will accept. Secrets go in on stdin, never
 * in argv, so they are not visible to `ps`.
 */

import { spawn } from 'node:child_process';

/** Max bytes we accept from a helper's stdout, to bound a misbehaving child. */
const MAX_OUTPUT_BYTES = 256 * 1024;

/** How long a helper may run before we kill it. */
const HELPER_TIMEOUT_MS = 10_000;

export type RunResult = { code: number; stdout: string; stderr: string };

/** Run a helper with no shell, feeding `input` on stdin and capturing stdout. */
export function runHelper(command: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: HELPER_TIMEOUT_MS
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
        stderr: Buffer.concat(err).toString('utf8')
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
export async function onPath(command: string): Promise<boolean> {
  try {
    const { code } = await runHelper('/usr/bin/env', ['which', command]);
    return code === 0;
  } catch {
    return false;
  }
}
