/** Local, out-of-band Fellow login. The password is read from a TTY with echo disabled. */

import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { FellowClient } from '@/fellow/client';
import { resolveLoginTimezone } from '@/fellow/timezone';

export async function readHiddenPassword(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): Promise<string> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    throw new Error('A local interactive TTY is required; the password is never accepted through argv.');
  }

  output.write('Fellow password: ');
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let password = '';
    const finish = (error?: Error) => {
      input.off('data', onData);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk: string | Buffer) => {
      for (const character of String(chunk)) {
        if (character === '\u0003') return finish(new Error('Login cancelled.'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') {
          password = password.slice(0, -1);
          continue;
        }
        if (character >= ' ') password += character;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Log in, optionally remembering the password.
 * `remember` trades a revocable refresh token for a long-lived credential on disk: it keeps the
 * server signed in with no human present, at the cost of a stored password. Opt-in only, and it is
 * refused outright when there is no keychain to encrypt it under (see SessionStore.write).
 */
export async function loginInteractively(
  client = new FellowClient(),
  opts: { remember?: boolean } = {}
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive login requires a local TTY; credentials are not accepted through argv or pipes.');
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await lines.question('Fellow email: ')).trim();
  lines.close();
  if (!email) throw new Error('Email is required.');

  const password = await readHiddenPassword();
  if (!password) throw new Error('Password is required.');
  const timezone = resolveLoginTimezone(process.env.AIDEN_AI_LOGIN_TIMEZONE);

  const result = await client.login({ email, password, timezone, remember: opts.remember });
  process.stdout.write(`Logged in as ${result.email}. You can now use auth.status through MCP.\n`);
  process.stdout.write(
    result.remembered
      ? 'Password stored in the encrypted session; the server will sign in again by itself if the refresh token expires. Run `bun run auth:login --forget` to undo.\n'
      : 'Password not stored. The session lasts until the Fellow refresh token expires; add --remember to keep signing in automatically.\n'
  );
}

/** Drop a remembered password without touching the rest of the session. */
export async function forgetPassword(client = new FellowClient()): Promise<void> {
  await client.forgetPassword();
  process.stdout.write('Remembered password discarded. The current session stays signed in until it expires.\n');
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const flags = process.argv.slice(2);
  const run = flags.includes('--forget')
    ? forgetPassword()
    : loginInteractively(undefined, { remember: flags.includes('--remember') });
  run.catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Login failed.'}\n`);
    process.exitCode = 1;
  });
}
