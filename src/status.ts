/** Read-only views: status table and the hit/miss ledger summary. */

import { readFileSync } from "node:fs";
import { HISTORY_PATH, type Config } from "./config";
import { scanSessions } from "./scan";
import { loadState } from "./state";

function fmt(ms: number): string {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

export function status(cfg: Config) {
  const state = loadState();
  const sessions = scanSessions(cfg);
  if (sessions.length === 0) {
    console.log("No sessions inside the warm window.");
    return;
  }
  const now = Date.now();
  console.log(`Warm window: ${cfg.windowHours}h · perProject=${cfg.perProject}\n`);
  for (const s of sessions) {
    const st = state[s.id];
    const interval = (cfg.intervals[s.provider] ?? cfg.defaultIntervalMinutes) * 60_000;
    const lastActivity = Math.max(
      s.lastUserAt.getTime(),
      st?.lastWarmAt ? Date.parse(st.lastWarmAt) : 0,
      s.mtime.getTime(),
    );
    const due = lastActivity + interval - now;
    const windowLeft =
      s.lastUserAt.getTime() + (cfg.windowHoursByProvider[s.provider] ?? cfg.windowHours) * 3_600_000 - now;
    const flag = st?.disabled ? ` DISABLED (${st.disabled})` : "";
    const hit = st?.lastCacheRead != null ? ` lastHit=${st.lastCacheRead}tok` : "";
    const drift = st?.driftEvents ? ` drifts=${st.driftEvents}` : "";
    console.log(
      `${s.id.slice(0, 8)}  ${s.model.padEnd(36)} every ${fmt(interval)}  next in ${due > 0 ? fmt(due) : "now"}  window left ${fmt(Math.max(0, windowLeft))}${hit}${drift}${flag}`,
    );
    console.log(`          ${s.cwd}`);
  }
}

interface LedgerEntry {
  ts: string;
  session: string;
  model: string;
  outcome: string;
  cacheRead: number;
  cacheWrite: number;
  input: number;
}

export function stats() {
  let entries: LedgerEntry[] = [];
  try {
    entries = readFileSync(HISTORY_PATH, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LedgerEntry);
  } catch {}
  if (entries.length === 0) {
    console.log("No warm history yet.");
    return;
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
}
