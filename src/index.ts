#!/usr/bin/env bun
/**
 * omp-cache-warmer — keeps oh-my-pi session prompt caches warm.
 *
 * How it works:
 *  - Scans ~/.omp/agent/sessions for sessions whose last *real* user message
 *    is within the warm window (default 24h).
 *  - On a per-provider interval, re-sends the exact same prompt prefix by
 *    resuming a *temporary copy* of the session file with a trivial message
 *    ("Respond with only: OK"). Writes go to a throwaway --session-dir, so
 *    the real session history never grows — no truncation, no piling up.
 *  - Verifies the prefix actually matched by reading usage.cacheRead from the
 *    warm response. Two consecutive misses => session disabled (prefix drift).
 */

import { mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";

// ---------------------------------------------------------------- config

interface Config {
  /** hours after last user message to keep warming */
  windowHours: number;
  /** warm interval per provider prefix, in minutes */
  intervals: Record<string, number>;
  /** fallback interval (minutes) for unlisted providers */
  defaultIntervalMinutes: number;
  /** message used for warming */
  message: string;
  /** "latest" = only newest session per project dir, "all" = every session in window */
  perProject: "latest" | "all";
  /** max warms per sweep (rate safety) */
  maxWarmsPerSweep: number;
  /** seconds before a warm run is killed */
  warmTimeoutSeconds: number;
  /** session id prefixes to never warm */
  exclude: string[];
  /**
   * What to do when the cache is predicted expired (no free way to ask the
   * server — cache status only comes back in the usage of a paid request):
   *  - "always": re-prime regardless of size (pays a full cache write)
   *  - "never": skip; only warm caches predicted still alive
   *  - number: re-prime only if the estimated prefix is at most this many tokens
   */
  coldReprime: "always" | "never" | number;
  /** omp binary */
  ompBin: string;
  /** session root override */
  sessionsRoot?: string;
}

const ROOT = join(homedir(), ".omp", "agent");
const DATA_DIR = join(ROOT, "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");
const LOG_PATH = join(DATA_DIR, "warmer.log");
const HISTORY_PATH = join(DATA_DIR, "history.jsonl");

const DEFAULT_CONFIG: Config = {
  windowHours: 24,
  intervals: {
    anthropic: 55, // Anthropic 1h cache TTL -> refresh at 55m
    "openai-codex": 8 * 60 + 1, // 8h01m -> fires twice in a 24h window (8h01m, 16h02m)
  },
  defaultIntervalMinutes: 55,
  message: "Respond with only: OK",
  perProject: "latest",
  maxWarmsPerSweep: 4,
  warmTimeoutSeconds: 300,
  coldReprime: 60_000,
  exclude: [],
  ompBin: "omp",
};

function loadConfig(): Config {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return { ...DEFAULT_CONFIG, ...user, intervals: { ...DEFAULT_CONFIG.intervals, ...(user.intervals ?? {}) } };
  } catch (e) {
    log(`config parse error, using defaults: ${e}`);
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------- state

interface SessionState {
  lastWarmAt?: string;
  lastCacheRead?: number;
  lastInputTokens?: number;
  lastCacheWrite?: number;
  /** consecutive expected-hit misses (prefix changed between warms) */
  misses: number;
  /** lifetime count of detected prefix drifts (each cost one cache write) */
  driftEvents?: number;
  disabled?: string; // reason
}
type State = Record<string, SessionState>;

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveState(state: State) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

// ---------------------------------------------------------------- session scanning

interface SessionInfo {
  id: string;
  file: string;
  cwd: string;
  model: string; // provider/model
  provider: string;
  lastUserAt: Date;
  mtime: Date;
}

function scanSessions(cfg: Config): SessionInfo[] {
  const root = cfg.sessionsRoot ?? join(ROOT, "sessions");
  const out: SessionInfo[] = [];
  if (!existsSync(root)) return out;
  const cutoff = Date.now() - cfg.windowHours * 3_600_000;

  for (const dir of readdirSync(root)) {
    const dirPath = join(root, dir);
    let files: string[];
    try {
      files = readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    let candidates: SessionInfo[] = [];
    for (const f of files) {
      const file = join(dirPath, f);
      const st = statSync(file);
      // cheap pre-filter: a session can't have a recent user message if the
      // file itself hasn't been written since the cutoff
      if (st.mtimeMs < cutoff) continue;
      const info = parseSession(file, st.mtime);
      if (info && info.lastUserAt.getTime() >= cutoff) candidates.push(info);
    }
    if (cfg.perProject === "latest" && candidates.length > 1) {
      candidates.sort((a, b) => b.lastUserAt.getTime() - a.lastUserAt.getTime());
      candidates = [candidates[0]];
    }
    out.push(...candidates);
  }
  return out;
}

function parseSession(file: string, mtime: Date): SessionInfo | null {
  let id = "";
  let cwd = "";
  let model = "";
  let lastUserAt: Date | null = null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const e = parsed as SessionEntry;
    if (e.type === "session" && e.id && e.cwd) {
      id = e.id;
      cwd = e.cwd;
    } else if (e.type === "model_change" && e.model) {
      model = e.model;
    } else if (e.type === "message" && e.message?.role === "user") {
      // ignore synthetic/tool-result user entries without text
      const content = e.message.content;
      const hasText =
        typeof content === "string" ||
        (Array.isArray(content) && content.some((c) => c.type === "text"));
      if (hasText && e.timestamp) lastUserAt = new Date(e.timestamp);
    }
  }
  if (!id || !model || !lastUserAt) return null;
  const provider = model.includes("/") ? model.split("/")[0] : model;
  return { id, file, cwd, model, provider, lastUserAt, mtime };
}

// ---------------------------------------------------------------- warming

/** shape of the jsonl entries we care about (validated field-by-field) */
interface SessionEntry {
  type?: string;
  id?: string;
  cwd?: string;
  model?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string }>;
    usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
  };
}

interface WarmResult {
  ok: boolean;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  detail: string;
}

async function warmSession(cfg: Config, s: SessionInfo): Promise<WarmResult> {
  const tmp = mkdtempSync(join(tmpdir(), "omp-cache-warmer-"));
  try {
    const copy = join(tmp, basename(s.file));
    cpSync(s.file, copy);
    const cwd = existsSync(s.cwd) ? s.cwd : process.cwd();
    const proc = Bun.spawn(
      [
        cfg.ompBin,
        "-r", copy,
        "-p", cfg.message,
        "--session-dir", tmp,
        "--no-title",
        "--cwd", cwd,
      ],
      {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
        // rewrite the prefix as a 1h-TTL cache entry on Anthropic
        env: { ...process.env, PI_CACHE_RETENTION: "long" },
      },
    );
    const killer = setTimeout(() => proc.kill(), cfg.warmTimeoutSeconds * 1000);
    const exit = await proc.exited;
    clearTimeout(killer);
    if (exit !== 0) {
      const err = await new Response(proc.stderr).text();
      return { ok: false, cacheRead: 0, cacheWrite: 0, input: 0, detail: `omp exited ${exit}: ${err.slice(-400)}` };
    }
    // find the warm response usage in whichever jsonl in tmp grew
    const usage = extractLastUsage(tmp);
    if (!usage) return { ok: false, cacheRead: 0, cacheWrite: 0, input: 0, detail: "no assistant usage found in warm output" };
    return { ok: true, ...usage, detail: "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function extractLastUsage(dir: string): { cacheRead: number; cacheWrite: number; input: number } | null {
  let best: { cacheRead: number; cacheWrite: number; input: number } | null = null;
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (f.endsWith(".jsonl")) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (!line.includes('"usage"')) continue;
          try {
            const parsed = JSON.parse(line) as SessionEntry;
            const u = parsed.message?.usage;
            if (parsed.type === "message" && parsed.message?.role === "assistant" && u) {
              best = {
                cacheRead: u.cacheRead ?? 0,
                cacheWrite: u.cacheWrite ?? 0,
                input: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
              };
            }
          } catch {}
        }
      }
    }
  };
  walk(dir);
  return best;
}

// ---------------------------------------------------------------- sweep

async function sweep(cfg: Config, opts: { force?: string } = {}): Promise<void> {
  const state = loadState();
  const sessions = scanSessions(cfg);
  const now = Date.now();
  let warmed = 0;

  // housekeeping: pins never expire logically, but drop ones whose session
  // hasn't been touched in 60 days (a re-resume simply re-pins fresh)
  const pinsDir = join(DATA_DIR, "pins");
  if (existsSync(pinsDir)) {
    for (const f of readdirSync(pinsDir)) {
      const p = join(pinsDir, f);
      try {
        if (now - statSync(p).mtimeMs > 60 * 86_400_000) rmSync(p, { force: true });
      } catch {}
    }
  }

  for (const s of sessions) {
    const st = (state[s.id] ??= { misses: 0 });
    const forced = opts.force && s.id.startsWith(opts.force);
    if (!forced) {
      if (st.disabled) continue;
      if (cfg.exclude.some((p) => s.id.startsWith(p))) continue;
      const interval = (cfg.intervals[s.provider] ?? cfg.defaultIntervalMinutes) * 60_000;
      // clock starts at the later of: last real user message, our last warm,
      // or the file's mtime (an active omp session keeps its own cache warm)
      const lastActivity = Math.max(
        s.lastUserAt.getTime(),
        st.lastWarmAt ? Date.parse(st.lastWarmAt) : 0,
        s.mtime.getTime(),
      );
      if (now - lastActivity < interval) continue;
      if (warmed >= cfg.maxWarmsPerSweep) continue;
    }
    const interval = (cfg.intervals[s.provider] ?? cfg.defaultIntervalMinutes) * 60_000;
    // a hit is only expected if the cache should still be alive: our last warm
    // (or the session's own activity) happened within the interval + slack.
    // No provider offers a free "does this cache exist" probe — status only
    // arrives in the usage of a paid request — so we predict from TTL math.
    const lastTouch = Math.max(st.lastWarmAt ? Date.parse(st.lastWarmAt) : 0, s.mtime.getTime());
    const expectHit = now - lastTouch < interval + 10 * 60_000;

    if (!expectHit && !forced && cfg.coldReprime !== "always") {
      // estimate prefix size: exact from the last warm, else ~chars/4
      const estTokens = st.lastInputTokens ?? Math.round(statSync(s.file).size / 4);
      if (cfg.coldReprime === "never" || estTokens > cfg.coldReprime) {
        st.disabled = `cache predicted expired; cold re-prime ~${estTokens} tokens exceeds coldReprime (${cfg.coldReprime})`;
        log(`skipping ${s.id.slice(0, 8)}: ${st.disabled} — force with: omp-cache-warmer warm ${s.id.slice(0, 8)}`);
        continue;
      }
    }

    log(`warming ${s.id.slice(0, 8)} (${s.model}, cwd=${s.cwd})`);
    const res = await warmSession(cfg, s);
    warmed++;
    st.lastWarmAt = new Date().toISOString();
    st.lastCacheRead = res.cacheRead;
    st.lastCacheWrite = res.cacheWrite;
    st.lastInputTokens = res.input;
    const outcome = !res.ok ? "failed" : res.input > 0 && res.cacheRead / res.input >= 0.5 ? "hit" : expectHit ? "drift" : "reprime";
    try {
      appendFileSync(
        HISTORY_PATH,
        JSON.stringify({
          ts: st.lastWarmAt,
          session: s.id,
          model: s.model,
          outcome,
          cacheRead: res.cacheRead,
          cacheWrite: res.cacheWrite,
          input: res.input,
          forced: Boolean(forced),
        }) + "\n",
      );
    } catch {}
    if (!res.ok) {
      log(`  warm failed: ${res.detail}`);
      continue; // transient failure: don't count as prefix miss
    }
    if (outcome === "hit") {
      st.misses = 0;
      if (st.disabled?.startsWith("cache predicted expired")) delete st.disabled;
      log(`  cache HIT ${((res.cacheRead / res.input) * 100).toFixed(1)}% (${res.cacheRead}/${res.input} tokens)`);
    } else if (outcome === "drift") {
      // prefix drifted since the last warm (omp update, date rollover, system
      // prompt change, ...). The miss itself re-primed the cache with the NEW
      // prefix — the same one a real resume would send — so we're re-aligned.
      st.misses++;
      st.driftEvents = (st.driftEvents ?? 0) + 1;
      log(
        `  prefix DRIFT: expected hit, got ${res.cacheRead}/${res.input} cached ` +
          `(re-primed new prefix, wrote ${res.cacheWrite} tokens) — drift ${st.misses}/2 consecutive`,
      );
      if (st.misses >= 2) {
        st.disabled =
          "prefix unstable: changed between consecutive warms twice — warming is futile " +
          "(a real resume would miss too); likely dynamic system prompt content (date, dir tree, extensions)";
        log(`  disabled ${s.id.slice(0, 8)}: ${st.disabled}`);
      }
    } else {
      if (st.disabled?.startsWith("cache predicted expired")) delete st.disabled;
      log(`  cold re-prime (${res.cacheRead}/${res.input} cached) — cache rewritten with fresh TTL`);
    }
  }
  saveState(state);
}

// ---------------------------------------------------------------- status / CLI

function status(cfg: Config) {
  const state = loadState();
  const sessions = scanSessions(cfg);
  if (sessions.length === 0) {
    console.log("No sessions inside the warm window.");
    return;
  }
  const now = Date.now();
  const fmt = (ms: number) => {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  };
  console.log(`Warm window: ${cfg.windowHours}h · perProject=${cfg.perProject}\n`);
  for (const s of sessions) {
    const st = state[s.id];
    const interval = (cfg.intervals[s.provider] ?? cfg.defaultIntervalMinutes) * 60_000;
    const lastActivity = Math.max(s.lastUserAt.getTime(), st?.lastWarmAt ? Date.parse(st.lastWarmAt) : 0, s.mtime.getTime());
    const due = lastActivity + interval - now;
    const windowLeft = s.lastUserAt.getTime() + cfg.windowHours * 3_600_000 - now;
    const flag = st?.disabled ? ` DISABLED (${st.disabled})` : "";
    const hit = st?.lastCacheRead != null ? ` lastHit=${st.lastCacheRead}tok` : "";
    const drift = st?.driftEvents ? ` drifts=${st.driftEvents}` : "";
    console.log(
      `${s.id.slice(0, 8)}  ${s.model.padEnd(36)} every ${fmt(interval)}  next in ${due > 0 ? fmt(due) : "now"}  window left ${fmt(Math.max(0, windowLeft))}${hit}${drift}${flag}`,
    );
    console.log(`          ${s.cwd}`);
  }
}

async function daemon(cfg: Config) {
  log(`omp-cache-warmer daemon started (window ${cfg.windowHours}h)`);
  // append-mode logging for the daemon
  while (true) {
    try {
      await sweep(loadConfig());
    } catch (e) {
      log(`sweep error: ${e}`);
    }
    await Bun.sleep(60_000);
  }
}

// Shows up in `launchctl list` and System Settings > General > Login Items &
// Extensions > Background items — name says exactly what it does.
const LAUNCHD_LABEL = "com.oh-my-pi.keep-ai-prompt-cache-warm";
function installLaunchd() {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const self = process.argv[1];
  const bun = process.execPath;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${bun}</string><string>${self}</string><string>daemon</string>
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

// Same self-explanatory naming for Linux (systemd user unit).
const SYSTEMD_UNIT = "omp-keep-ai-prompt-cache-warm";
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

async function main() {
  const cfg = loadConfig();
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "daemon":
    case "run":
      await daemon(cfg);
      break;
    case "once":
      await sweep(cfg);
      break;
    case "warm":
      if (!arg) throw new Error("usage: omp-cache-warmer warm <session-id-prefix>");
      await sweep(cfg, { force: arg });
      break;
    case "status":
    case undefined:
      status(cfg);
      break;
    case "enable": {
      if (!arg) throw new Error("usage: omp-cache-warmer enable <session-id-prefix>");
      const state = loadState();
      for (const [id, st] of Object.entries(state)) if (id.startsWith(arg)) { delete st.disabled; st.misses = 0; }
      saveState(state);
      console.log("re-enabled");
      break;
    }
    case "install":
      if (process.platform === "darwin") installLaunchd();
      else installSystemd();
      break;
    case "uninstall":
      if (process.platform === "darwin") uninstallLaunchd();
      else uninstallSystemd();
      break;
    case "stats": {
      let entries: Array<{ ts: string; session: string; model: string; outcome: string; cacheRead: number; cacheWrite: number; input: number }> = [];
      try {
        entries = readFileSync(HISTORY_PATH, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as (typeof entries)[number]);
      } catch {}
      if (entries.length === 0) {
        console.log("No warm history yet.");
        break;
      }
      const byOutcome: Record<string, number> = {};
      let read = 0;
      let wrote = 0;
      for (const e of entries) {
        byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
        read += e.cacheRead;
        wrote += e.cacheWrite;
      }
      console.log(`${entries.length} warms since ${entries[0].ts}`);
      console.log(`  outcomes: ${Object.entries(byOutcome).map(([k, v]) => `${k}=${v}`).join("  ")}`);
      console.log(`  tokens:   cacheRead=${read}  cacheWrite=${wrote}`);
      const misses = entries.filter((e) => e.outcome === "drift" || e.outcome === "failed");
      for (const m of misses.slice(-10)) console.log(`  miss: ${m.ts}  ${m.session.slice(0, 8)}  ${m.outcome}  ${m.cacheRead}/${m.input}`);
      break;
    }
    case "config":
      console.log(CONFIG_PATH);
      console.log(readFileSync(CONFIG_PATH, "utf8"));
      break;
    default:
      console.log(`omp-cache-warmer — keep omp prompt caches warm

usage:
  omp-cache-warmer status            show sessions in the warm window (default)
  omp-cache-warmer once              run a single warm sweep
  omp-cache-warmer daemon            run forever (sweeps every minute)
  omp-cache-warmer warm <id>         force-warm one session now
  omp-cache-warmer enable <id>       re-enable a disabled session
  omp-cache-warmer install           install as macOS launchd agent
  omp-cache-warmer uninstall         remove the launchd agent
  omp-cache-warmer stats             hit/miss ledger summary (history.jsonl)
  omp-cache-warmer config            show config path + contents`);
  }
}

main();
