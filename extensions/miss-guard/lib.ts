/** Shared prediction logic + constants for the miss-guard extension. */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
  coldReprime?: "always" | "never" | number;
}

export interface PrefixChange {
  kind: "diverged" | "unstable" | "pin-refreshed" | "warm-missed";
  detail: string;
}

export interface Prediction {
  warm: boolean;
  /** ms until predicted expiry (warm) or since expiry (cold) */
  deltaMs: number;
  estTokens: number;
  idleMin: number;
  /** minutes a cache entry survives after its last touch (provider TTL + slack) */
  aliveMin: number;
  /** when the cache was last refreshed */
  lastTouchAt: Date;
  /** what refreshed it: the warmer daemon's ping or the session's own request */
  touchSource: "warmer ping" | "session activity";
  /** set when the request prefix is known to differ from the cached one */
  prefixChanged?: PrefixChange;
  provider: string;
}

export function loadWarmerConfig(): WarmerConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WarmerConfig;
  } catch {
    return {};
  }
}

/**
 * Ground truth for the current context size AND the last paid request: the
 * usage block of the LAST assistant message in the session file. Unlike the
 * daemon's snapshot or size/4, this survives compaction (which shrinks the next
 * request while the append-only file only grows). Returns both the total tokens
 * and the timestamp of that paid request — the only event that actually touches
 * the provider cache.
 */
export function tailAssistantUsage(file: string): { tokens: number; ts: number } | undefined {
  try {
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"usage"')) continue;
      try {
        const e = JSON.parse(lines[i]) as {
          type?: string;
          timestamp?: string;
          message?: { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
        };
        const u = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : undefined;
        if (u) {
          const tokens = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
          const ts = e.timestamp ? Date.parse(e.timestamp) : 0;
          return { tokens, ts };
        }
      } catch {}
    }
  } catch {}
  return undefined;
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
  let touchSource: "warmer ping" | "session activity" = "session activity";
  let estTokens = 0;
  let lastWarmMs = 0;
  let prefixChanged: PrefixChange | undefined;
  let lastCacheRead: number | undefined;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<
      string,
      { lastWarmAt?: string; lastInputTokens?: number; lastCacheRead?: number; disabled?: string }
    >;
    const st = state[id];
    if (st?.lastWarmAt) {
      lastWarmMs = Date.parse(st.lastWarmAt);
      lastTouch = lastWarmMs;
      touchSource = "warmer ping";
    }
    if (st?.lastInputTokens) estTokens = st.lastInputTokens;
    if (typeof st?.lastCacheRead === "number") lastCacheRead = st.lastCacheRead;
    // the daemon already proved the prefix changed for this session
    if (st?.disabled?.startsWith("lineage divergence")) prefixChanged = { kind: "diverged", detail: st.disabled };
    else if (st?.disabled?.startsWith("prefix unstable")) prefixChanged = { kind: "unstable", detail: st.disabled };
  } catch {}
  // a pin refreshed after the cache was last written means it holds the OLD prompt
  if (!prefixChanged && lastWarmMs > 0) {
    try {
      const pinStat = statSync(join(DATA_DIR, "pins", `${id}.json`));
      if (pinStat.birthtimeMs > lastWarmMs) {
        prefixChanged = {
          kind: "pin-refreshed",
          detail: `prompt pin re-captured ${new Date(pinStat.birthtimeMs).toLocaleTimeString()}, after the last warm`,
        };
      }
    } catch {}
  }
  if (file) {
    try {
      // Only a paid request (assistant message with usage) touches the provider
      // cache. mtime bumps on resumes/branch edits/metadata writes with ZERO API
      // calls, so it must NOT count as a cache touch.
      const tail = tailAssistantUsage(file);
      if (tail && tail.ts > lastTouch) {
        lastTouch = tail.ts;
        touchSource = "session activity";
      }
      // freshest first: real usage from the file tail beats the daemon's
      // (possibly pre-compaction) snapshot, which beats crude size/4
      if (tail && tail.ts > lastWarmMs) estTokens = tail.tokens;
      if (!estTokens) estTokens = Math.round(statSync(file).size / 4);
    } catch {}
  }
  // Stale-flag guard: the daemon's prefix-change verdicts (and the pin check)
  // describe the cache as of the LAST WARM. If this session's own activity
  // wrote the cache more recently, the cached prefix IS the live rendering —
  // whatever the daemon observed hours ago no longer applies.
  if (prefixChanged && touchSource === "session activity") prefixChanged = undefined;
  // Warm-missed guard: if the daemon's own last warm MISSED (lastCacheRead 0 =
  // full re-read + rewrite from a drift/cold re-prime) AND that warm is still
  // the newest touch (the session file did NOT supersede it above, so
  // touchSource is still "warmer ping"), the cache holds the daemon's fresh
  // rendering — unproven for this live session's bytes. Runs after the
  // file-mtime comparison: any session activity after the warm re-cached the
  // live prefix and must NOT trip this flag.
  if (!prefixChanged && touchSource === "warmer ping" && lastCacheRead === 0) {
    prefixChanged = {
      kind: "warm-missed",
      detail: "last daemon warm MISSED (drift/re-prime): cache holds the daemon's fresh rendering, unproven for this live session",
    };
  }
  if (lastTouch === 0) return; // brand-new session: nothing cached yet

  const aliveMs = intervalMs + 10 * 60_000;
  const idle = Date.now() - lastTouch;
  return {
    warm: idle < aliveMs,
    deltaMs: Math.abs(aliveMs - idle),
    estTokens,
    idleMin: Math.round(idle / 60_000),
    aliveMin: Math.round(aliveMs / 60_000),
    lastTouchAt: new Date(lastTouch),
    touchSource,
    prefixChanged,
    provider,
  };
}
