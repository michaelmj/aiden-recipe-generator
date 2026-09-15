/** IANA timezone resolution shared by every Fellow login path. */

/** Rejects UTC offsets ("+05:00") and other non-zone-name strings Intl would otherwise accept. */
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+.-]+)*$/;

/** Canonical form of a valid IANA zone name, or undefined if the name is not one. */
export function canonicalTimezone(timezone: string): string | undefined {
  const candidate = timezone.trim();
  if (!ZONE_NAME.test(candidate)) return undefined;

  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function isValidTimezone(timezone: string): boolean {
  return canonicalTimezone(timezone) !== undefined;
}

/** The host's own zone, or undefined when the runtime cannot report a usable one. */
export function hostTimezone(): string | undefined {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return resolved ? canonicalTimezone(resolved) : undefined;
}

/**
 * The zone to send with a login: an explicit value if given, otherwise the host's own.
 * Never falls back to an unrelated region — an operator whose host cannot report a zone
 * has to name one, so Fellow is never told the account lives somewhere it does not.
 */
export function resolveLoginTimezone(explicit?: string, host: () => string | undefined = hostTimezone): string {
  if (explicit !== undefined) {
    const canonical = canonicalTimezone(explicit);
    // The value is not echoed back: it travels into the model's context on failure.
    if (!canonical) throw new Error('timezone must be an IANA zone name such as America/Detroit.');
    return canonical;
  }

  const local = host();
  if (!local)
    throw new Error('Could not determine the local IANA timezone; pass an explicit timezone such as America/Detroit.');
  return local;
}
