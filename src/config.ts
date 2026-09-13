/**
 * Application configuration and constants.
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const APP_ID = 'aiden-ai-profile-generator';
export const APP_VERSION = '0.1.0';

/** Fellow's API endpoint (reverse-engineered from mobile app) */
export const FELLOW_API_BASE = 'https://l8qtmnc692.execute-api.us-west-2.amazonaws.com/v1';

/** HTTP request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Community Aiden recipes spreadsheet */
export const DEFAULT_SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1mi-YS6JYfbX3wN1kZd6iu_q6mFlWM4Ah6N3Ox8eqRCA/export?format=csv&gid=0';

/**
 * Hosts the community sheet may be fetched from.
 * The sheet URL is the one network target this server will follow to attacker-influenced values,
 * so it is pinned to a host list rather than accepting any URL. Operators can add hosts with
 * AIDEN_AI_SHEET_ALLOWED_HOSTS (comma-separated); the model cannot.
 */
export const DEFAULT_SHEET_HOSTS = ['docs.google.com'] as const;

/** Allowed sheet hosts, including any operator additions from the environment. */
export function getSheetHostAllowlist(): string[] {
  const extra = (process.env.AIDEN_AI_SHEET_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_SHEET_HOSTS, ...extra];
}

/** Maximum redirects followed when fetching the sheet; each hop is re-checked against the allowlist. */
export const SHEET_MAX_REDIRECTS = 3;

/**
 * Hard cap on the sheet body we will read into memory.
 * The response is stranger-controlled, so it is read as a bounded stream and aborted past this
 * many bytes rather than trusted to end. The real sheet is a few hundred KB.
 */
export const SHEET_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Content types the sheet fetch will parse. Anything else (an HTML sign-in or error page, say)
 * is rejected instead of being fed to the CSV parser as if it were data.
 */
export const SHEET_ALLOWED_CONTENT_TYPES = ['text/csv', 'text/plain'] as const;

/**
 * Shape caps for the parsed CSV. The sheet is column-oriented: a row is one field label and a
 * column is one recipe, so a crafted sheet grows cost in two directions. Anything past a cap is
 * rejected rather than truncated, so a sheet that is quietly wrong is never served as if it were
 * complete.
 */
export const SHEET_MAX_ROWS = 200;
export const SHEET_MAX_COLUMNS = 2_000;
/** Longest single CSV record csv-parse will buffer before raising (default is 128_000). */
export const SHEET_MAX_RECORD_CHARS = 256_000;

/**
 * Local data directory (~/.aiden-ai-profile-generator).
 * AIDEN_AI_DATA_DIR relocates it. Tests rely on this: os.homedir() ignores process.env.HOME under
 * Bun, so overriding HOME is not enough to keep a test run out of the real user's cache.
 */
export function getAppDataDir() {
  const override = process.env.AIDEN_AI_DATA_DIR?.trim();
  return override ? resolve(override) : join(homedir(), `.${APP_ID}`);
}
