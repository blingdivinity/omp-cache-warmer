/** Shared prediction logic + constants for the miss-guard extension. */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");

/**
 * omp's prune/supersede pass flushes+rewrites the whole sent history when THIS
 * PROCESS has been idle longer than PRUNE_IDLE_FLUSH_MS (90m upstream), on the
 * assumption the provider cache is cold. An external warmer breaks that
 * assumption: the cache is warm, but the rewritten request misses it anyway.
 * We warn slightly early (85m) so the user sends before the flush window.
 */
export const OMP_IDLE_FLUSH_MS = 90 * 60_000;
export const IDLE_FLUSH_WARN_MS = 85 * 60_000;
/** live-warm's own safety cutoff: a ping past this would trigger the flush itself */
export const PING_SAFE_IDLE_MS = 88 * 60_000;

export interface WarmerConfig {
  intervals?: Record<string, number>;
  defaultIntervalMinutes?: number;
  /** predicted-miss confirmation threshold in tokens; false disables the dialog */
  missConfirmTokens?: number | false;
}

export interface Prediction {
  warm: boolean;
  /** ms until predicted expiry (warm) or since expiry (cold) */
  deltaMs: number;
  estTokens: number;
  idleMin: number;
  provider: string;
}

export function loadWarmerConfig(): WarmerConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WarmerConfig;
  } catch {
    return {};
  }
}

export function predict(ctx: ExtensionContext, cfg: WarmerConfig): Prediction | undefined {
  const id = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile?.();
  const provider = ctx.model?.provider;
  if (!id || !provider) return;

  // same aliveness prediction as the daemon: cache is alive if the session
  // was touched (own request or warmer ping) within interval + slack
  const intervalMs = (cfg.intervals?.[provider] ?? cfg.defaultIntervalMinutes ?? 55) * 60_000;
  let lastTouch = 0;
  let estTokens = 0;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<
      string,
      { lastWarmAt?: string; lastInputTokens?: number }
    >;
    const st = state[id];
    if (st?.lastWarmAt) lastTouch = Date.parse(st.lastWarmAt);
    if (st?.lastInputTokens) estTokens = st.lastInputTokens;
  } catch {}
  if (file) {
    try {
      const fst = statSync(file);
      lastTouch = Math.max(lastTouch, fst.mtimeMs);
      if (!estTokens) estTokens = Math.round(fst.size / 4);
    } catch {}
  }
  if (lastTouch === 0) return; // brand-new session: nothing cached yet

  const aliveMs = intervalMs + 10 * 60_000;
  const idle = Date.now() - lastTouch;
  return {
    warm: idle < aliveMs,
    deltaMs: Math.abs(aliveMs - idle),
    estTokens,
    idleMin: Math.round(idle / 60_000),
    provider,
  };
}
