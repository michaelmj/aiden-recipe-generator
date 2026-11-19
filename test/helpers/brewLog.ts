/** Seed a brew log on disk in a shape logBrew no longer writes, to test reading old entries. */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function writeRawBrewLog(dir: string, entries: unknown[]): void {
  writeFileSync(join(dir, 'brew-log.json'), JSON.stringify({ entries }), { mode: 0o600 });
}

/** An entry as logged before aiden-recipe-generator-46y.2: ratio and bloom only, with a slot id. */
export function legacyEntry(id: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    timestamp: 1_794_068_506_788,
    coffee: { name: title },
    profile: { id: 'p9', title, ratio: 16, bloomTemp: 95, bloomDuration: 45, ...extra }
  };
}
