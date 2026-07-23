/** Helpers for the live-warm extension: config, logging, daemon coordination. */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");
const LOG = join(DATA_DIR, "live-warm.log");

/** stop pinging before omp's PRUNE_IDLE_FLUSH_MS (90m): a ping after that would trigger the flush */
export const IDLE_FLUSH_CUTOFF_MS = 88 * 60_000;

export interface LiveWarmConfig {
  message?: string;
  liveWarm?: boolean;
  intervals?: Record<string, number>;
  defaultIntervalMinutes?: number;
  liveWarmIntervalMinutes?: number;
}

export interface UsageShape {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function logLine(msg: string) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export function loadCfg(): LiveWarmConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LiveWarmConfig;
  } catch {
    return {};
  }
}

/** Interval the auto-ping timer uses; shared so the timer and arm path can't drift. */
export function intervalMsFor(cfg: LiveWarmConfig, provider: string | undefined): number {
  return (
    (cfg.liveWarmIntervalMinutes ?? cfg.intervals?.[provider ?? ""] ?? cfg.defaultIntervalMinutes ?? 55) * 60_000
  );
}

/** Let the daemon know this lineage was just warmed so it backs off. */
export function markWarmInSharedState(ctx: ExtensionContext) {
  const id = ctx.sessionManager.getSessionId();
  if (!id) return;
  try {
    let state: Record<string, { lastWarmAt?: string; misses?: number }>;
    try {
      state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<
        string,
        { lastWarmAt?: string; misses?: number }
      >;
    } catch {
      state = {};
    }
    state[id] = { ...(state[id] ?? { misses: 0 }), lastWarmAt: new Date().toISOString() };
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  } catch {}
}
