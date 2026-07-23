/** Shared paths, logging, and configuration for omp-cache-warmer. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = join(homedir(), ".omp", "agent");
export const DATA_DIR = join(ROOT, "omp-cache-warmer");
export const CONFIG_PATH = join(DATA_DIR, "config.json");
export const STATE_PATH = join(DATA_DIR, "state.json");
export const LOG_PATH = join(DATA_DIR, "warmer.log");
export const HISTORY_PATH = join(DATA_DIR, "history.jsonl");

export interface Config {
  /** hours after last user message to keep warming */
  windowHours: number;
  /** per-provider window override (hours), keyed by provider prefix */
  windowHoursByProvider: Record<string, number>;
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

export const DEFAULT_CONFIG: Config = {
  windowHours: 24,
  windowHoursByProvider: {},
  intervals: {
    anthropic: 55, // Anthropic 1h cache TTL -> refresh at 55m
    "openai-codex": 8 * 60 + 1, // 8h01m -> fires twice in a 24h window (8h01m, 16h02m)
  },
  defaultIntervalMinutes: 55,
  message: "Respond with only: OK",
  perProject: "latest",
  maxWarmsPerSweep: 4,
  warmTimeoutSeconds: 300,
  coldReprime: "never",
  exclude: [],
  ompBin: "omp",
};

export function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {}
}

export function loadConfig(): Config {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    return { ...DEFAULT_CONFIG };
  }
  try {
    const user = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...user,
      intervals: { ...DEFAULT_CONFIG.intervals, ...(user.intervals ?? {}) },
      windowHoursByProvider: { ...DEFAULT_CONFIG.windowHoursByProvider, ...(user.windowHoursByProvider ?? {}) },
    };
  } catch (e) {
    log(`config parse error, using defaults: ${e}`);
    return { ...DEFAULT_CONFIG };
  }
}
