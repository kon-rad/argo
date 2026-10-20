import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface HermesHome {
  /** 'main' for ~/.hermes, otherwise the profile's name. */
  profile: string;
  dir: string;
}

/** ~/.hermes plus every profile that has a state.db or a cron folder. */
export function findHomes(root: string): HermesHome[] {
  const homes: HermesHome[] = [{ profile: 'main', dir: root }];
  const profiles = join(root, 'profiles');
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles).sort()) {
      const dir = join(profiles, name);
      if (existsSync(join(dir, 'state.db')) || existsSync(join(dir, 'cron'))) homes.push({ profile: name, dir });
    }
  }
  return homes;
}

/** The flat `timezone:` key of Hermes's config.yaml (it drives all cron times), or null. */
export function hermesTimezone(root: string): string | null {
  const file = join(root, 'config.yaml');
  if (!existsSync(file)) return null;
  const m = /^timezone:\s*["']?([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*)["']?\s*$/m.exec(readFileSync(file, 'utf8'));
  return m ? m[1]! : null;
}
