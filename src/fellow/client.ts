/**
 * Fellow Aiden API Client
 *
 * Reverse-engineered from the Fellow mobile app.
 */

import { FELLOW_API_BASE, REQUEST_TIMEOUT_MS } from '@/config';
import { decodeJwtExpMs, type Session, SessionStore } from '@/fellow/session';
import { AIDEN_LIMITS, type AidenCreateProfileInput, type AidenUpdateProfileInput } from '@/schemas';
import { sanitizeText, TITLE_MAX_CHARS } from '@/text';

/** Aiden device state (filtered from verbose API response) */
export type Device = {
  id: string;
  displayName: string;
  serialNumber: string;
  isConnected: boolean;
  brewing: boolean;
  brewingProfileId: string | null;
  singleBrewBasketPresent: boolean;
  batchBrewBasketPresent: boolean;
  carafePresent: boolean;
  lidClosed: boolean;
  missingWater: boolean;
};

/** Brew profile stored on the device */
export type Profile = {
  id: string;
  /** Neutralized and length-capped: Drops titles are authored outside this account */
  title: string;
  /** Custom = user-created, Fellow = defaults, Drops = from Fellow's library, Unknown = unrecognized */
  folder: 'Custom' | 'Fellow' | 'Drops' | 'Unknown';
  /** Water to coffee ratio (e.g., 16 = 1:16) */
  ratio: number;
  bloomEnabled: boolean;
  /** Bloom water ratio (e.g., 2 = 2x coffee weight) */
  bloomRatio: number;
  /** Bloom duration in seconds */
  bloomDuration: number;
  /** Bloom temperature in Celsius */
  bloomTemperature: number;
  /** Single-serve pulse settings */
  ssPulsesEnabled: boolean;
  ssPulsesNumber: number;
  ssPulsesInterval: number;
  ssPulseTemperatures: number[];
  /** Batch brew pulse settings */
  batchPulsesEnabled: boolean;
  batchPulsesNumber: number;
  batchPulsesInterval: number | null;
  batchPulseTemperatures: number[];
  /**
   * What the device reported that this code would not vouch for — an out-of-range number, a
   * mangled title, a folder label we do not know. Present only when something was off, so the
   * model can see the anomaly instead of reading a doctored value as fact.
   */
  anomalies?: string[];
};

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/**
 * Read a numeric profile field, recording anything outside what an Aiden can physically do.
 * The number is still reported as the device sent it — this is the brewer's own state, and quietly
 * clamping it would describe a profile that does not exist — but an out-of-range value is listed as
 * an anomaly so the model does not read it as brewing advice. Drops profiles are authored outside
 * the account, so the API is not a trusted source of bounded values. See docs/THREAT-MODEL.md.
 */
function boundedNum(
  raw: unknown,
  field: string,
  range: { min: number; max: number },
  fallback: number,
  anomalies: string[]
): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    if (raw !== undefined && raw !== null) anomalies.push(`${field} was not a number; reporting ${fallback}`);
    return fallback;
  }
  if (raw < range.min || raw > range.max) {
    anomalies.push(`${field}=${raw} is outside the device range ${range.min}-${range.max}`);
  }
  return raw;
}

/** Read a pulse-temperature list, capped at one temperature per possible pulse. */
function boundedTemperatures(raw: unknown, field: string, anomalies: string[]): number[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    anomalies.push(`${field} was not a list of temperatures`);
    return [];
  }

  const numbers = raw.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (numbers.length !== raw.length) anomalies.push(`${field} had ${raw.length - numbers.length} non-numeric entries`);

  const kept = numbers.slice(0, AIDEN_LIMITS.pulsesNumber.max);
  if (kept.length < numbers.length) {
    anomalies.push(`${field} listed ${numbers.length} temperatures; kept the first ${kept.length}`);
  }

  const { min, max } = AIDEN_LIMITS.temperature;
  const strays = kept.filter((t) => t < min || t > max);
  if (strays.length > 0) anomalies.push(`${field} has ${strays.length} temperatures outside ${min}-${max}`);

  return kept;
}

function toDevice(raw: Record<string, unknown>): Device {
  return {
    id: str(raw.id),
    displayName: str(raw.displayName, 'Unknown'),
    serialNumber: str(raw.serialNumber),
    isConnected: Boolean(raw.isConnected),
    brewing: Boolean(raw.brewing),
    brewingProfileId: typeof raw.brewingProfileId === 'string' ? raw.brewingProfileId : null,
    singleBrewBasketPresent: Boolean(raw.singleBrewBasketPresent),
    batchBrewBasketPresent: Boolean(raw.batchBrewBasketPresent),
    carafePresent: Boolean(raw.carafePresent),
    lidClosed: Boolean(raw.lidClosed),
    missingWater: Boolean(raw.missingWater)
  };
}

const VALID_FOLDERS: readonly Profile['folder'][] = ['Custom', 'Fellow', 'Drops'];

/**
 * Shape one profile from the API response.
 * Every field is checked rather than coerced: these values reach aiden.listProfiles output, which
 * the model reads, and a Drops title is not the user's own text.
 */
function toProfile(raw: Record<string, unknown>): Profile {
  const anomalies: string[] = [];

  // An unrecognized folder used to fall back to 'Custom', which is the one label that makes
  // updateProfile and deleteProfile willing to write. Unknown fails closed instead.
  const isKnownFolder = VALID_FOLDERS.includes(raw.folder as Profile['folder']);
  if (!isKnownFolder) anomalies.push(`folder '${sanitizeText(str(raw.folder), 40)}' is not a folder this client knows`);
  const folder = isKnownFolder ? (raw.folder as Profile['folder']) : 'Unknown';

  const rawTitle = str(raw.title);
  const title = sanitizeText(rawTitle, TITLE_MAX_CHARS);
  if (title !== rawTitle) anomalies.push('title was shortened or stripped of unprintable characters');

  const profile: Profile = {
    id: str(raw.id),
    title,
    folder,
    ratio: boundedNum(raw.ratio, 'ratio', AIDEN_LIMITS.ratio, 16, anomalies),
    bloomEnabled: Boolean(raw.bloomEnabled),
    bloomRatio: boundedNum(raw.bloomRatio, 'bloomRatio', AIDEN_LIMITS.bloomRatio, 2, anomalies),
    bloomDuration: boundedNum(raw.bloomDuration, 'bloomDuration', AIDEN_LIMITS.bloomDuration, 30, anomalies),
    bloomTemperature: boundedNum(raw.bloomTemperature, 'bloomTemperature', AIDEN_LIMITS.temperature, 96, anomalies),
    ssPulsesEnabled: Boolean(raw.ssPulsesEnabled),
    ssPulsesNumber: boundedNum(raw.ssPulsesNumber, 'ssPulsesNumber', AIDEN_LIMITS.pulsesNumber, 3, anomalies),
    ssPulsesInterval: boundedNum(raw.ssPulsesInterval, 'ssPulsesInterval', AIDEN_LIMITS.pulsesInterval, 23, anomalies),
    ssPulseTemperatures: boundedTemperatures(raw.ssPulseTemperatures, 'ssPulseTemperatures', anomalies),
    batchPulsesEnabled: Boolean(raw.batchPulsesEnabled),
    batchPulsesNumber: boundedNum(raw.batchPulsesNumber, 'batchPulsesNumber', AIDEN_LIMITS.pulsesNumber, 1, anomalies),
    batchPulsesInterval:
      raw.batchPulsesInterval === null || raw.batchPulsesInterval === undefined
        ? null
        : boundedNum(raw.batchPulsesInterval, 'batchPulsesInterval', AIDEN_LIMITS.pulsesInterval, 23, anomalies),
    batchPulseTemperatures: boundedTemperatures(raw.batchPulseTemperatures, 'batchPulseTemperatures', anomalies)
  };

  if (anomalies.length > 0) profile.anomalies = anomalies;
  return profile;
}

/**
 * Encode a single URL path segment.
 * Ids arrive as tool arguments, so a raw "..", "?" or "#" would otherwise reshape the
 * authenticated request path. See docs/THREAT-MODEL.md.
 */
const seg = (value: string) => encodeURIComponent(value);

/**
 * Describe a failed upstream call without quoting its body.
 * Every thrown message reaches the model's context, and a Fellow error body can carry the bearer
 * token that was sent, the account email, or the request payload, so only the status code and a
 * fixed hint travel. See docs/THREAT-MODEL.md.
 */
function upstreamError(label: string, status: number): Error {
  const hint =
    status === 401 || status === 403
      ? 'the stored session is no longer valid; run `bun run auth:login` again'
      : status === 404
        ? 'Fellow has no such device or profile'
        : status === 429
          ? 'Fellow is rate limiting this account; wait a moment and retry'
          : status >= 500
            ? 'Fellow had a server-side problem; retry in a little while'
            : 'Fellow did not accept the request';
  return new Error(`${label} failed (${status}): ${hint}.`);
}

/**
 * Treat a token as spent this long before its stated expiry.
 * A minute absorbs ordinary clock skew between this machine and Fellow, so a request does not go
 * out carrying a token the server has already retired.
 */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/** Backoff between refresh attempts that failed for a reason that may pass on its own. */
const REFRESH_RETRY_DELAYS_MS = [500, 2_000];

const NO_SESSION_MESSAGE = 'No Fellow session stored yet. Run `bun run auth:login` in a local terminal to sign in.';
const RE_LOGIN_MESSAGE = 'The Fellow session expired and could not be refreshed. Run `bun run auth:login` again.';

/**
 * A refresh that produced no token.
 * `terminal` separates "Fellow rejected this refresh token", which only a new login fixes, from
 * "the call never got through" — a dropped connection, a timeout, a Fellow outage — which says
 * nothing about the credentials and must not cost the user their session.
 */
class RefreshFailure extends Error {
  constructor(
    readonly terminal: boolean,
    readonly status: number | undefined,
    message: string
  ) {
    super(message);
    this.name = 'RefreshFailure';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True once the stored access token is at or past its usable life.
 * A token whose exp claim could not be read is used until Fellow rejects it; send() recovers from
 * that 401 rather than guessing a lifetime.
 */
function isSpent(session: Session): boolean {
  return session.accessTokenExpMs !== undefined && Date.now() > session.accessTokenExpMs - TOKEN_EXPIRY_SKEW_MS;
}

/**
 * Client for the Fellow Aiden API.
 * Handles auth, device queries, and profile management.
 */
export class FellowClient {
  private store = new SessionStore();

  /**
   * The refresh currently in flight, and the access token it is replacing.
   * Tool calls arrive in parallel, and Fellow hands back a new refresh token each time: two
   * concurrent refreshes would spend the same refresh token twice and leave the loser's rotated
   * token stored but already void — the "keeps asking me to log in again" failure. Callers that
   * want the same token replaced wait on the one call instead of starting their own.
   */
  private refreshInFlight: { staleToken: string; promise: Promise<string> } | null = null;

  /** Authenticate with Fellow and store session locally */
  async login(args: { email: string; password: string; timezone: string }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${FELLOW_API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(args),
        signal: controller.signal
      });

      if (!res.ok) {
        // The body is not quoted: a login response can echo back the submitted email or password,
        // and a thrown message travels straight into the model's context.
        const reason =
          res.status === 401 || res.status === 403
            ? 'double-check the email and password'
            : 'Fellow did not accept the login';
        throw new Error(`Login failed (${res.status}): ${reason}.`);
      }

      const json = (await res.json()) as { accessToken?: string; refreshToken?: string; token?: string };
      const accessToken = json.accessToken ?? json.token;
      if (!accessToken) throw new Error('Login response missing accessToken.');

      const session: Session = {
        email: args.email,
        accessToken,
        refreshToken: json.refreshToken,
        obtainedAtMs: Date.now(),
        accessTokenExpMs: decodeJwtExpMs(accessToken)
      };
      await this.store.write(session);

      return { ok: true, email: args.email };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Check if we have a valid session */
  async status() {
    const session = await this.store.read();
    return { ok: true, loggedIn: Boolean(session), email: session?.email };
  }

  /** Clear stored session */
  async logout() {
    await this.store.clear();
    return { ok: true };
  }

  /** The token to send, refreshing first when the stored one has run out its clock. */
  private async getToken(): Promise<string> {
    const session = await this.store.read();
    if (!session?.accessToken) throw new Error(NO_SESSION_MESSAGE);
    if (!isSpent(session)) return session.accessToken;
    return this.reauthorize(session.accessToken);
  }

  /**
   * Replace `staleToken` with a working one, at most once per stale token.
   * Concurrent callers holding the same dead token share the single call rather than racing each
   * other through Fellow's refresh-token rotation.
   */
  private reauthorize(staleToken: string): Promise<string> {
    const existing = this.refreshInFlight;
    if (existing?.staleToken === staleToken) return existing.promise;

    const promise = this.renew(staleToken).finally(() => {
      if (this.refreshInFlight?.promise === promise) this.refreshInFlight = null;
    });
    this.refreshInFlight = { staleToken, promise };
    return promise;
  }

  /** One attempt at getting back to a usable token. Callers go through reauthorize(). */
  private async renew(staleToken: string): Promise<string> {
    // Re-read first: another process — a second MCP server, or `bun run auth:login` in a terminal —
    // may already have written a good token while this call was queued.
    const session = await this.store.read();
    if (!session?.accessToken) throw new Error(NO_SESSION_MESSAGE);
    if (session.accessToken !== staleToken && !isSpent(session)) return session.accessToken;

    if (session.refreshToken) {
      try {
        return await this.refreshSession(session);
      } catch (err) {
        // A refresh that never reached Fellow says nothing about the credentials. Reporting it as
        // an expired session is what sends people back to `auth:login` while their session is fine.
        if (err instanceof RefreshFailure && !err.terminal) {
          throw new Error(
            `Could not reach Fellow to refresh the session (${err.message}). The stored session is still there; retry in a moment.`
          );
        }
      }
    }

    throw new Error(RE_LOGIN_MESSAGE);
  }

  /**
   * Exchange the refresh token for a new access token, retrying what is worth retrying.
   * Throws RefreshFailure so the caller can tell a rejected credential from an unreachable API.
   */
  private async refreshSession(session: Session): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.refreshOnce(session);
      } catch (err) {
        const failure =
          err instanceof RefreshFailure ? err : new RefreshFailure(false, undefined, (err as Error).message);
        if (failure.terminal || attempt >= REFRESH_RETRY_DELAYS_MS.length) throw failure;
        await sleep(REFRESH_RETRY_DELAYS_MS[attempt] ?? 0);
      }
    }
  }

  private async refreshOnce(session: Session): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let res: Response;
      try {
        res = await fetch(`${FELLOW_API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
          signal: controller.signal
        });
      } catch {
        // Connection refused, DNS failure, or our own timeout: nothing was decided upstream.
        const reason = controller.signal.aborted ? 'the request timed out' : 'network error';
        throw new RefreshFailure(false, undefined, reason);
      }

      if (!res.ok) {
        // 408/429/5xx can pass; 400/401/403 mean Fellow will not honour this refresh token again.
        // The body is never quoted — it can echo the token that was sent. See docs/THREAT-MODEL.md.
        const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
        throw new RefreshFailure(!retryable, res.status, `Fellow answered ${res.status}`);
      }

      const json = (await res.json().catch(() => ({}))) as { accessToken?: string; refreshToken?: string };
      const accessToken = json.accessToken;
      if (!accessToken) throw new RefreshFailure(true, res.status, 'the refresh response carried no accessToken');

      const updated: Session = {
        ...session,
        accessToken,
        refreshToken: json.refreshToken ?? session.refreshToken,
        obtainedAtMs: Date.now(),
        accessTokenExpMs: decodeJwtExpMs(accessToken)
      };
      await this.store.write(updated);

      return accessToken;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Send one authenticated request with the given token. No retry, no error mapping. */
  private async attempt(
    method: string,
    path: string,
    token: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<Response> {
    const url = new URL(`${FELLOW_API_BASE}${path}`);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`
    };
    if (opts?.body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await fetch(url, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Send an authenticated request, renewing the token once if Fellow rejects it.
   * An access token can stop working before the exp claim says it should — revoked from the phone
   * app, invalidated by a password change, or simply issued by a clock that disagrees with ours.
   * Expiry alone is therefore not a sufficient trigger: a 401 is the server telling us directly,
   * and the request never ran, so re-sending it after a refresh is safe for writes too.
   */
  private async send(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<Response> {
    const token = await this.getToken();
    const res = await this.attempt(method, path, token, opts);

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      const renewed = await this.reauthorize(token);
      const retry = await this.attempt(method, path, renewed, opts);
      if (!retry.ok) throw upstreamError(`${method} ${path}`, retry.status);
      return retry;
    }

    if (!res.ok) throw upstreamError(`${method} ${path}`, res.status);
    return res;
  }

  /**
   * Call the API and parse a JSON body.
   * A 200 that is not JSON — a proxy's HTML, a captive portal, a body with no content-type — used to
   * come back as `undefined`, which the list callers then dereferenced; the failure surfaced as a
   * TypeError about `.map` instead of saying what went wrong.
   */
  private async requestJson<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<T> {
    const res = await this.send(method, path, opts);
    const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    // The body is not quoted, for the same reason upstreamError does not quote one.
    if (!mediaType.includes('json')) {
      throw new Error(`${method} ${path} answered '${mediaType || 'no content-type'}', expected JSON.`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`${method} ${path} answered with a body that is not valid JSON.`);
    }
  }

  /** Call the API and discard the body, for endpoints that answer with no content. */
  private async requestVoid(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<void> {
    await this.send(method, path, opts);
  }

  /**
   * Like requestJson, but for writes: a successful POST or PATCH may answer 204, or 200 with no
   * body, and that is not a failure. Returns undefined when there is no JSON to read.
   */
  private async requestOptionalJson<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<T | undefined> {
    const res = await this.send(method, path, opts);
    if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('json')) return undefined;
    try {
      return (await res.json()) as T;
    } catch {
      return undefined;
    }
  }

  /** A JSON list endpoint; an object or a bare value where a list belongs is an upstream change. */
  private async requestJsonArray(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<Record<string, unknown>[]> {
    const parsed = await this.requestJson<unknown>(method, path, opts);
    if (!Array.isArray(parsed)) throw new Error(`${method} ${path} answered with a single value, expected a list.`);
    return parsed as Record<string, unknown>[];
  }

  /** List all Aiden devices on the account */
  async listDevices(opts: { dataType?: 'real' | 'cached' } = {}): Promise<Device[]> {
    const raw = await this.requestJsonArray('GET', '/devices', {
      query: { dataType: opts.dataType ?? 'real' }
    });
    return raw.map(toDevice);
  }

  /** Get a specific device by ID */
  async getDevice(args: { deviceId: string; dataType?: 'real' | 'cached' }): Promise<Device> {
    const raw = await this.requestJson<Record<string, unknown>>('GET', `/devices/${seg(args.deviceId)}`, {
      query: { dataType: args.dataType ?? 'real' }
    });
    return toDevice(raw);
  }

  /** List all profiles on a device */
  async listProfiles(args: { deviceId: string }): Promise<Profile[]> {
    const raw = await this.requestJsonArray('GET', `/devices/${seg(args.deviceId)}/profiles`);
    return raw.map(toProfile);
  }

  /**
   * Get a specific profile by ID.
   * Note: Fellow API doesn't support fetching single profile, so we fetch all and filter.
   */
  async getProfile(args: { deviceId: string; profileId: string }): Promise<Profile> {
    const profile = (await this.listProfiles(args)).find((p) => p.id === args.profileId);
    if (!profile)
      throw new Error(`No profile "${args.profileId}" on this device. List the profiles to see what is there.`);
    return profile;
  }

  /** Create a new profile on the device */
  async createProfile(args: { deviceId: string; profile: AidenCreateProfileInput }) {
    return this.requestOptionalJson<Record<string, unknown>>('POST', `/devices/${seg(args.deviceId)}/profiles`, {
      body: args.profile
    });
  }

  /** Update an existing Custom profile (cannot modify Fellow/Drops profiles) */
  async updateProfile(args: { deviceId: string; profileId: string; patch: AidenUpdateProfileInput }) {
    const profile = await this.getProfile(args);
    if (profile.folder !== 'Custom')
      throw new Error(
        `Only Custom profiles can be edited, and "${args.profileId}" is a ${profile.folder} profile. ` +
          'Create a Custom copy and change that instead.'
      );
    return this.requestOptionalJson<Record<string, unknown>>(
      'PATCH',
      `/devices/${seg(args.deviceId)}/profiles/${seg(args.profileId)}`,
      {
        body: args.patch
      }
    );
  }

  /** Delete a Custom profile (cannot delete Fellow/Drops profiles) */
  async deleteProfile(args: { deviceId: string; profileId: string }) {
    const profile = await this.getProfile(args);
    if (profile.folder !== 'Custom')
      throw new Error(`Only Custom profiles can be deleted, and "${args.profileId}" is a ${profile.folder} profile.`);
    await this.requestVoid('DELETE', `/devices/${seg(args.deviceId)}/profiles/${seg(args.profileId)}`);
    return { ok: true };
  }
}
