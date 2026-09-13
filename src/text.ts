/**
 * Text neutralizer for strings that arrive from outside this process.
 *
 * Both remote sources feed the model: the community sheet (written by strangers) and the Fellow
 * API (Drops profiles are authored outside the user's account). Neither is trusted for shape or
 * size, so their free text is stripped of ANSI escapes, control characters, and invisible
 * characters, collapsed, and length-capped before it can reach tool output.
 */

/** Longest free-text value kept (titles are tighter; see TITLE_MAX_CHARS). */
export const TEXT_MAX_CHARS = 200;
/** Longest title kept. */
export const TITLE_MAX_CHARS = 120;
/** Longest string read at all — anything past this is truncated before sanitizing. */
const RAW_MAX_CHARS = 4_000;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** Zero-width and bidi-override characters, which hide text from a human reading the output. */
const INVISIBLE_CHARS = /[\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;

/** Strip escapes and invisible characters, collapse whitespace, trim, and cap length. */
export function sanitizeText(value: string, maxChars = TEXT_MAX_CHARS): string {
  return value
    .slice(0, RAW_MAX_CHARS)
    .replace(ANSI_ESCAPE, '')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}
