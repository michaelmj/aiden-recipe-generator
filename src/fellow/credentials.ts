/**
 * Fellow credentials held outside this process.
 *
 * `auth:login --remember` keeps the Fellow password inside the encrypted session file so the
 * server can sign in again with nobody present. That works, but it turns a revocable session into
 * an account password at rest, on a machine an agent is already running code on. The alternative
 * this module implements is the one a secret manager is for: the password lives in 1Password (or
 * any equivalent), the server is launched under a wrapper that hands it over for that run only,
 * and nothing long-lived is ever written to our own disk.
 *
 * Two shapes, both through AIDEN_AI_FELLOW_PASSWORD:
 *
 *   - **Injected value** — `op run --env-file=.env -- bun run src/index.ts`, with the env file
 *     holding `AIDEN_AI_FELLOW_PASSWORD=op://Vault/Fellow/password`. The 1Password CLI resolves the
 *     reference before we start and sets the variable for this process only. Nothing here has to
 *     know 1Password exists.
 *   - **Unresolved reference** — the variable holds the literal `op://...` string and we resolve it
 *     through `op read` at the moment a re-login actually needs it. The secret is then absent from
 *     the process environment (where any child process and any `/proc/<pid>/environ` reader would
 *     find it) for all the time it is not in use, which is nearly all of it. It needs `op` on PATH
 *     and a non-interactive 1Password session — a service account token — because a long-lived MCP
 *     server has no terminal to answer a biometric prompt on.
 *
 * The reference itself is a pointer, not a secret, so it is fine in argv; the resolved value never
 * goes near argv, a log line, a tool result, or the session file.
 */

import { runHelper } from '@/proc';

/** Fellow account to sign in as. Optional: the stored session already knows the email. */
export const EMAIL_ENV = 'AIDEN_AI_FELLOW_EMAIL';

/** The password itself, or an `op://vault/item/field` reference to it. */
export const PASSWORD_ENV = 'AIDEN_AI_FELLOW_PASSWORD';

/** 1Password secret-reference scheme, as written in an `op run` env file. */
const SECRET_REF_PREFIX = 'op://';

/** A Fellow password is a password; anything this long means we read the wrong thing. */
const MAX_SECRET_CHARS = 1024;

export type ExternalCredentials = { email: string; password: string };

/** Trimmed env value, or undefined when unset or blank. */
function readEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/**
 * Whether this process was given credentials to sign in with.
 * Deliberately env-only: `auth.status` calls it, and status must not spawn the 1Password CLI or
 * trigger an unlock prompt just to answer a question about configuration.
 */
export function externalCredentialsConfigured(): boolean {
  return readEnv(PASSWORD_ENV) !== undefined;
}

export function isSecretReference(value: string): boolean {
  return value.startsWith(SECRET_REF_PREFIX);
}

/** Resolves an `op://` reference to its value. Replaceable so tests never invoke the real CLI. */
export type SecretResolver = (reference: string) => Promise<string>;

let resolverOverride: SecretResolver | undefined;

/** Test seam: install (or with `undefined`, remove) a stand-in for the 1Password CLI. */
export function setSecretResolverForTests(resolver: SecretResolver | undefined): void {
  resolverOverride = resolver;
}

/**
 * Read one secret through the 1Password CLI.
 * Failures name the variable and the exit code only. `op`'s own stderr can quote the reference,
 * the account, and occasionally the item's contents, and everything thrown here travels into the
 * agent's context.
 */
async function resolveWithOp(reference: string): Promise<string> {
  let result: Awaited<ReturnType<typeof runHelper>>;
  try {
    result = await runHelper('op', ['read', '--no-newline', reference]);
  } catch (err) {
    throw new Error(
      `${PASSWORD_ENV} holds a 1Password reference, but the \`op\` CLI could not be run (${(err as Error).message}). ` +
        'Install the 1Password CLI, or resolve the reference before startup with `op run --env-file=...`.'
    );
  }

  if (result.code !== 0) {
    throw new Error(
      `The 1Password CLI could not read the secret named by ${PASSWORD_ENV} (exit ${result.code}). ` +
        'Check the reference and that the server has a non-interactive 1Password session ' +
        '(OP_SERVICE_ACCOUNT_TOKEN) — there is no terminal here to approve an unlock prompt on.'
    );
  }

  return result.stdout.replace(/\r?\n$/, '');
}

/**
 * The credentials this process was given, with any secret reference resolved, or null when none
 * were configured. `fallbackEmail` is the stored session's email, so a server that already knows
 * who it is needs only the password variable.
 */
export async function readExternalCredentials(fallbackEmail?: string): Promise<ExternalCredentials | null> {
  const configured = readEnv(PASSWORD_ENV);
  if (configured === undefined) return null;

  const email = readEnv(EMAIL_ENV) ?? fallbackEmail;
  if (!email) {
    throw new Error(`${PASSWORD_ENV} is set but no Fellow account is known yet; set ${EMAIL_ENV} as well.`);
  }

  const password = isSecretReference(configured) ? await (resolverOverride ?? resolveWithOp)(configured) : configured;

  if (!password) throw new Error(`${PASSWORD_ENV} resolved to an empty value.`);
  if (password.length > MAX_SECRET_CHARS) {
    throw new Error(`${PASSWORD_ENV} resolved to ${password.length} characters, which is not a Fellow password.`);
  }

  return { email, password };
}
