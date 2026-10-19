import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The scheduler entry that runs `ledger run` every interval. One per OS; the text is
 * built by pure functions (tested) and written by cli-ledger's `install`.
 */
export interface ScheduleSpec { node: string; bundle: string; intervalSec: number; dataDir: string; logFile: string }

export const LAUNCHD_LABEL = 'com.secondbrain.ledger';
export const SYSTEMD_UNIT = 'secondbrain-ledger';
export const SCHTASKS_NAME = 'SecondBrainLedger';

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist(s: ScheduleSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(s.node)}</string><string>--no-warnings</string><string>${xml(s.bundle)}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>SB_LEDGER_DIR</key><string>${xml(s.dataDir)}</string></dict>
  <key>StartInterval</key><integer>${s.intervalSec}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logFile)}</string>
</dict></plist>
`;
}

const q = (s: string): string => `"${s.replace(/(["\\])/g, '\\$1')}"`;

export function systemdUnits(s: ScheduleSpec): { service: string; timer: string } {
  return {
    service: `[Unit]
Description=Second Brain agent ledger: collect agent sessions, sync to the server

[Service]
Type=oneshot
Environment=SB_LEDGER_DIR=${q(s.dataDir)}
ExecStart=${q(s.node)} --no-warnings ${q(s.bundle)} run
StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}
`,
    timer: `[Unit]
Description=Run the Second Brain agent ledger every ${s.intervalSec}s

[Timer]
OnBootSec=60
OnUnitActiveSec=${s.intervalSec}
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

/** Arguments for `schtasks`. Task Scheduler's minimum repeat is one minute. */
export function schtasksArgs(s: ScheduleSpec): string[] {
  const minutes = Math.max(1, Math.round(s.intervalSec / 60));
  const cmd = `cmd /c set SB_LEDGER_DIR=${s.dataDir}&& ${q(s.node)} --no-warnings ${q(s.bundle)} run >> ${q(s.logFile)} 2>&1`;
  return ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(minutes), '/TN', SCHTASKS_NAME, '/TR', cmd];
}

export function logFileFor(platform: NodeJS.Platform, dataDir: string, home = homedir()): string {
  return platform === 'darwin' ? join(home, 'Library', 'Logs', 'secondbrain-ledger.log') : join(dataDir, 'ledger.log');
}

// The capture proxy runs all the time and is restarted at once if it dies: Claude Code can't reach the
// API while it is down (the scheduled `ledger run` also takes Claude Code off it after two failed checks).
export const LAUNCHD_PROXY_LABEL = 'com.secondbrain.ledger-proxy';
export const SYSTEMD_PROXY_UNIT = 'secondbrain-ledger-proxy';
export const SCHTASKS_PROXY_NAME = 'SecondBrainLedgerProxy';

export function launchdProxyPlist(s: ScheduleSpec): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_PROXY_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(s.node)}</string><string>--no-warnings</string><string>${xml(s.bundle)}</string><string>proxy</string></array>
  <key>EnvironmentVariables</key><dict><key>SB_LEDGER_DIR</key><string>${xml(s.dataDir)}</string></dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>2</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(s.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(s.logFile)}</string>
</dict></plist>
`;
}

export function systemdProxyUnit(s: ScheduleSpec): string {
  return `[Unit]
Description=Second Brain capture proxy: records Claude Code's API calls into the agent ledger

[Service]
Environment=SB_LEDGER_DIR=${q(s.dataDir)}
ExecStart=${q(s.node)} --no-warnings ${q(s.bundle)} proxy
Restart=always
RestartSec=1
StandardOutput=append:${s.logFile}
StandardError=append:${s.logFile}

[Install]
WantedBy=default.target
`;
}

export function schtasksProxyArgs(s: ScheduleSpec): string[] {
  const cmd = `cmd /c set SB_LEDGER_DIR=${s.dataDir}&& ${q(s.node)} --no-warnings ${q(s.bundle)} proxy >> ${q(s.logFile)} 2>&1`;
  return ['/Create', '/F', '/SC', 'ONLOGON', '/TN', SCHTASKS_PROXY_NAME, '/TR', cmd];
}
