/** Local, out-of-band Fellow login. The password is read from a TTY with echo disabled. */

import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { FellowClient } from '@/fellow/client';

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

export async function loginInteractively(client = new FellowClient()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive login requires a local TTY; credentials are not accepted through argv or pipes.');
  }
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  const email = (await lines.question('Fellow email: ')).trim();
  lines.close();
  if (!email) throw new Error('Email is required.');

  const password = await readHiddenPassword();
  if (!password) throw new Error('Password is required.');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone) throw new Error('Could not determine the local IANA timezone.');

  const result = await client.login({ email, password, timezone });
  process.stdout.write(`Logged in as ${result.email}. You can now use auth.status through MCP.\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  loginInteractively().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Login failed.'}\n`);
    process.exitCode = 1;
  });
}
