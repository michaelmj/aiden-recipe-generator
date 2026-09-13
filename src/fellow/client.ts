/**
 * Fellow Aiden API Client
 *
 * Reverse-engineered from the Fellow mobile app.
 */

import { FELLOW_API_BASE, REQUEST_TIMEOUT_MS } from '@/config';
import { decodeJwtExpMs, type Session, SessionStore } from '@/fellow/session';
import type { AidenCreateProfileInput, AidenUpdateProfileInput } from '@/schemas';

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
  title: string;
  /** Custom = user-created, Fellow = defaults, Drops = from Fellow's library */
  folder: 'Custom' | 'Fellow' | 'Drops';
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
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' ? v : fallback);
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const numArray = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []);

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

function toProfile(raw: Record<string, unknown>): Profile {
  const folder = VALID_FOLDERS.includes(raw.folder as Profile['folder'])
    ? (raw.folder as Profile['folder'])
    : 'Custom';

  return {
    id: str(raw.id),
    title: str(raw.title),
    folder,
    ratio: num(raw.ratio, 16),
    bloomEnabled: Boolean(raw.bloomEnabled),
    bloomRatio: num(raw.bloomRatio, 2),
    bloomDuration: num(raw.bloomDuration, 30),
    bloomTemperature: num(raw.bloomTemperature, 96),
    ssPulsesEnabled: Boolean(raw.ssPulsesEnabled),
    ssPulsesNumber: num(raw.ssPulsesNumber, 3),
    ssPulsesInterval: num(raw.ssPulsesInterval, 23),
    ssPulseTemperatures: numArray(raw.ssPulseTemperatures),
    batchPulsesEnabled: Boolean(raw.batchPulsesEnabled),
    batchPulsesNumber: num(raw.batchPulsesNumber, 1),
    batchPulsesInterval: typeof raw.batchPulsesInterval === 'number' ? raw.batchPulsesInterval : null,
    batchPulseTemperatures: numArray(raw.batchPulseTemperatures)
  };
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
      ? 'not authorized; call auth.login again'
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
    if (!session?.accessToken) throw new Error('Not logged in. Call auth.login first.');

    // Check if token is expired or about to expire (30s buffer)
    const isExpired = session.accessTokenExpMs && Date.now() > session.accessTokenExpMs - 30_000;

    if (isExpired && session.refreshToken) {
      // Attempt automatic refresh
      try {
        return await this.refreshSession(session);
      } catch {
        throw new Error('Session expired and refresh failed. Please auth.login again.');
      }
    }

    if (isExpired) {
      throw new Error('Access token expired. Please auth.login again.');
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

  private async request<T>(
    method: string,
    path: string,
    opts?: { query?: Record<string, unknown>; body?: unknown }
  ): Promise<T> {
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

      return res.headers.get('content-type')?.includes('application/json')
        ? ((await res.json()) as T)
        : (undefined as T);
    } finally {
      clearTimeout(timeout);
    }
  }

  /** List all Aiden devices on the account */
  async listDevices(opts: { dataType?: 'real' | 'cached' } = {}): Promise<Device[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', '/devices', {
      query: { dataType: opts.dataType ?? 'real' }
    });
    return raw.map(toDevice);
  }

  /** Get a specific device by ID */
  async getDevice(args: { deviceId: string; dataType?: 'real' | 'cached' }): Promise<Device> {
    const raw = await this.request<Record<string, unknown>>('GET', `/devices/${seg(args.deviceId)}`, {
      query: { dataType: args.dataType ?? 'real' }
    });
    return toDevice(raw);
  }

  /** List all profiles on a device */
  async listProfiles(args: { deviceId: string }): Promise<Profile[]> {
    const raw = await this.request<Record<string, unknown>[]>('GET', `/devices/${seg(args.deviceId)}/profiles`);
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
    return this.request<Record<string, unknown>>('POST', `/devices/${seg(args.deviceId)}/profiles`, { body: args.profile });
  }

  /** Update an existing Custom profile (cannot modify Fellow/Drops profiles) */
  async updateProfile(args: { deviceId: string; profileId: string; patch: AidenUpdateProfileInput }) {
    const profile = await this.getProfile(args);
    if (profile.folder !== 'Custom') throw new Error(`Cannot modify ${profile.folder} profile "${args.profileId}".`);
    return this.request<Record<string, unknown>>('PATCH', `/devices/${seg(args.deviceId)}/profiles/${seg(args.profileId)}`, {
      body: args.patch
    });
  }

  /** Delete a Custom profile (cannot delete Fellow/Drops profiles) */
  async deleteProfile(args: { deviceId: string; profileId: string }) {
    const profile = await this.getProfile(args);
    if (profile.folder !== 'Custom') throw new Error(`Cannot delete ${profile.folder} profile "${args.profileId}".`);
    await this.request<void>('DELETE', `/devices/${seg(args.deviceId)}/profiles/${seg(args.profileId)}`);
    return { ok: true };
  }
}
