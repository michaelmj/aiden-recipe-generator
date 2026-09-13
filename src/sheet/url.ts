/**
 * Sheet URL validation.
 *
 * The sheet URL can be influenced by whatever the agent has read, and the fetched body is parsed,
 * cached, and echoed back to the agent — a request primitive and a read primitive in one. So the
 * target is checked against an operator-controlled host allowlist before any request is made, and
 * again after every redirect. See docs/THREAT-MODEL.md (S2).
 */

import { getSheetHostAllowlist } from '@/config';

export class DisallowedSheetUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisallowedSheetUrlError';
  }
}

/**
 * Parse and vet a sheet URL.
 * @throws DisallowedSheetUrlError if the URL is malformed, not https, carries credentials,
 *   or points at a host outside the allowlist.
 */
export function assertAllowedSheetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DisallowedSheetUrlError(`Not a valid URL: ${raw}`);
  }

  if (url.protocol !== 'https:') {
    throw new DisallowedSheetUrlError(`Sheet URL must use https, got "${url.protocol}".`);
  }

  if (url.username || url.password) {
    throw new DisallowedSheetUrlError('Sheet URL must not carry credentials.');
  }

  const allowed = getSheetHostAllowlist();
  if (!allowed.includes(url.hostname.toLowerCase())) {
    throw new DisallowedSheetUrlError(
      `Host "${url.hostname}" is not an allowed sheet host (allowed: ${allowed.join(', ')}). ` +
        'Set AIDEN_AI_SHEET_ALLOWED_HOSTS to add one.'
    );
  }

  return url;
}
