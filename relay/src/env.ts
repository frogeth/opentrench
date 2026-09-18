// Environment → relay options. Kept apart from the process entry so it can be
// tested; a bad value never stops the relay, it warns and keeps the default.
import type { RelayOptions } from './relay.js';

export type Env = Record<string, string | undefined>;

export function readEnv(env: Env, warn: (m: string) => void): { port: number; options: RelayOptions } {
  const int = (name: string): number | undefined => {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) {
      warn(`${name}=${JSON.stringify(v)} is not a whole number of 1 or more; using the default`);
      return undefined;
    }
    return n;
  };
  const flag = (name: string): boolean => {
    const v = env[name];
    if (v === undefined || v === '' || v === '0' || v === 'false') return false;
    if (v === '1' || v === 'true') return true;
    warn(`${name}=${JSON.stringify(v)} is not 1 or 0; treating it as off`);
    return false;
  };
  const options: RelayOptions = { trustProxy: flag('RELAY_TRUST_PROXY') };
  const accessCode = env.RELAY_ACCESS_CODE;
  if (accessCode) options.accessCode = accessCode;
  const maxRooms = int('RELAY_MAX_ROOMS');
  if (maxRooms !== undefined) options.maxRooms = maxRooms;
  const maxMembers = int('RELAY_MAX_MEMBERS');
  if (maxMembers !== undefined) options.maxMembers = maxMembers;
  if (env.RELAY_DATA_DIR) options.dataDir = env.RELAY_DATA_DIR;
  const bufferHours = int('RELAY_BUFFER_HOURS');
  if (bufferHours !== undefined) options.bufferHours = bufferHours;
  return { port: int('PORT') ?? 8080, options };
}
