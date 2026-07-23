/** Per-session warm state and the shared session-entry JSONL shape. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DATA_DIR, STATE_PATH } from "./config";

export interface SessionState {
  lastWarmAt?: string;
  lastCacheRead?: number;
  lastInputTokens?: number;
  lastCacheWrite?: number;
  /** consecutive expected-hit misses (prefix changed between warms) */
  misses: number;
  /** count of full-miss drifts within a rolling 24h window (see classifyDrift) */
  driftEvents?: number;
  /** ISO timestamp of the most recent counted drift (windows driftEvents) */
  lastDriftAt?: string;
  disabled?: string; // reason
  /** omp version at last warm — a change explains one systemic drift */
  ompVersion?: string;
}

export type State = Record<string, SessionState>;

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveState(state: State) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

/** shape of the session jsonl entries we care about (validated field-by-field) */
export interface SessionEntry {
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
