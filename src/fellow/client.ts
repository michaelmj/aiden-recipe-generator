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
      ? 'not authorized; run `bun run auth:login` again'
      : status === 404
        ? 'not found'
        : status === 429
          ? 'rate limited by Fellow; retry later'
          : status >= 500
            ? 'Fellow service error; retry later'
            : 'Fellow rejected the request';
  return new Error(`${label} failed (${status}): ${hint}.`);
}

/**
 * Client for the Fellow Aiden API.
 * Handles auth, device queries, and profile management.
 */
export class FellowClient {
  private store = new SessionStore();

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
          res.status === 401 || res.status === 403 ? 'check the email and password' : 'Fellow rejected the login';
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

  private async getToken(): Promise<string> {
    const session = await this.store.read();
    if (!session?.accessToken) throw new Error('Not logged in. Run `bun run auth:login` in a local terminal first.');

    // Check if token is expired or about to expire (30s buffer)
    const isExpired = session.accessTokenExpMs && Date.now() > session.accessTokenExpMs - 30_000;

    if (isExpired && session.refreshToken) {
      // Attempt automatic refresh
      try {
        return await this.refreshSession(session);
      } catch {
        throw new Error('Session expired and refresh failed. Run `bun run auth:login` again.');
      }
    }

    if (isExpired) {
      throw new Error('Access token expired. Run `bun run auth:login` again.');
    }

    return session.accessToken;
  }

  private async refreshSession(session: Session): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${FELLOW_API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
        signal: controller.signal
      });

      if (!res.ok) throw new Error('Refresh failed');

      const json = (await res.json()) as { accessToken?: string; refreshToken?: string };
      const accessToken = json.accessToken;
      if (!accessToken) throw new Error('Refresh response missing accessToken');

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

  private async send(
    method: string,
    path: string,
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
      Authorization: `Bearer ${await this.getToken()}`
    };
    if (opts?.body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      });
      if (!res.ok) throw upstreamError(`${method} ${path}`, res.status);
      return res;
    } finally {
      clearTimeout(timeout);
    }
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
    if (!profile) throw new Error(`Profile "${args.profileId}" not found.`);
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
    if (profile.folder !== 'Custom') throw new Error(`Cannot modify ${profile.folder} profile "${args.profileId}".`);
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
    if (profile.folder !== 'Custom') throw new Error(`Cannot delete ${profile.folder} profile "${args.profileId}".`);
    await this.requestVoid('DELETE', `/devices/${seg(args.deviceId)}/profiles/${seg(args.profileId)}`);
    return { ok: true };
  }
}
