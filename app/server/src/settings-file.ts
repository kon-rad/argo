import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface SettingsFileError {
  kind: 'read' | 'json';
  message: string;
}

export interface SettingsFileResult {
  path: string;
  raw: unknown | null;
  error: SettingsFileError | null;
}

/** Resolve the structured settings file without importing the process-wide config. */
export function settingsPath(vaultRoot: string): string {
  const configured = process.env.SECONDBRAIN_SETTINGS;
  if (configured) return isAbsolute(configured) ? configured : join(vaultRoot, configured);
  return join(vaultRoot, 'secondbrain.json');
}

/** Read and JSON-decode the optional settings file once, without applying its schema. */
export function loadSettingsFile(vaultRoot: string): SettingsFileResult {
  const path = settingsPath(vaultRoot);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return { path, raw: null, error: null };
    return { path, raw: null, error: { kind: 'read', message: error.message.split('\n')[0] ?? 'read failed' } };
  }

  try {
    return { path, raw: JSON.parse(text) as unknown, error: null };
  } catch (err) {
    return {
      path,
      raw: null,
      error: { kind: 'json', message: err instanceof Error ? err.message.split('\n')[0] ?? 'invalid JSON' : 'invalid JSON' },
    };
  }
}
