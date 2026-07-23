/** Background-service install: launchd agent (macOS) / systemd user unit (Linux). */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LOG_PATH } from "./config";

// Shows up in `launchctl list` and System Settings > General > Login Items &
// Extensions > Background items — name says exactly what it does.
const LAUNCHD_LABEL = "com.oh-my-pi.keep-ai-prompt-cache-warm";
// Same self-explanatory naming for Linux.
const SYSTEMD_UNIT = "omp-keep-ai-prompt-cache-warm";

export function installService() {
  if (process.platform === "darwin") installLaunchd();
  else installSystemd();
}

export function uninstallService() {
  if (process.platform === "darwin") uninstallLaunchd();
  else uninstallSystemd();
}

function installLaunchd() {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${process.argv[1]}</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG_PATH.replace(".log", ".launchd.log")}</string>
  <key>StandardErrorPath</key><string>${LOG_PATH.replace(".log", ".launchd.log")}</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string>
  </dict>
</dict></plist>
`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist);
  Bun.spawnSync(["launchctl", "unload", plistPath]);
  const r = Bun.spawnSync(["launchctl", "load", plistPath]);
  console.log(r.exitCode === 0 ? `Installed + started launchd agent: ${plistPath}` : `Wrote ${plistPath}, but launchctl load failed`);
}

function uninstallLaunchd() {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  Bun.spawnSync(["launchctl", "unload", plistPath]);
  rmSync(plistPath, { force: true });
  console.log(`Removed ${plistPath}`);
}

function installSystemd() {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const unitPath = join(unitDir, `${SYSTEMD_UNIT}.service`);
  const unit = `[Unit]
Description=oh-my-pi: keep AI prompt caches warm (omp-cache-warmer daemon)

[Service]
ExecStart=${process.execPath} ${process.argv[1]} daemon
Restart=always
RestartSec=10
Environment=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}

[Install]
WantedBy=default.target
`;
  mkdirSync(unitDir, { recursive: true });
  writeFileSync(unitPath, unit);
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  const r = Bun.spawnSync(["systemctl", "--user", "enable", "--now", `${SYSTEMD_UNIT}.service`]);
  console.log(r.exitCode === 0 ? `Installed + started systemd user unit: ${unitPath}` : `Wrote ${unitPath}, but systemctl enable failed`);
  const linger = Bun.spawnSync(["loginctl", "enable-linger"]);
  console.log(
    linger.exitCode === 0
      ? "Lingering enabled: daemon runs even with no login session."
      : "NOTE: could not enable lingering; run `sudo loginctl enable-linger $USER` so the daemon survives logout.",
  );
}

function uninstallSystemd() {
  const unitPath = join(homedir(), ".config", "systemd", "user", `${SYSTEMD_UNIT}.service`);
  Bun.spawnSync(["systemctl", "--user", "disable", "--now", `${SYSTEMD_UNIT}.service`]);
  rmSync(unitPath, { force: true });
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"]);
  console.log(`Removed ${unitPath}`);
}
