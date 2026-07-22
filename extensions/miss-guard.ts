import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Miss guard: predicts the prompt-cache state for this session with the same
 * TTL math as the warmer daemon.
 *
 *  - Status-bar indicator: "🔥 43m" (predicted warm, time until expiry) or
 *    "❄ ~85k tok" (predicted cold, size of the uncached re-read).
 *  - Before a large message would cold-miss (>= missConfirmTokens), pops a
 *    yes/no confirmation so an expensive re-read is never a surprise.
 */

const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");

interface WarmerConfig {
  intervals?: Record<string, number>;
  defaultIntervalMinutes?: number;
  /** predicted-miss confirmation threshold in tokens; false disables the dialog */
  missConfirmTokens?: number | false;
}

interface Prediction {
  warm: boolean;
  /** ms until predicted expiry (warm) or since expiry (cold) */
  deltaMs: number;
  estTokens: number;
  idleMin: number;
  provider: string;
}

function predict(ctx: ExtensionContext, cfg: WarmerConfig): Prediction | undefined {
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

function loadWarmerConfig(): WarmerConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WarmerConfig;
  } catch {
    return {};
  }
}

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;

  const refreshIndicator = () => {
    const ctx = lastCtx;
    if (!ctx?.hasUI) return;
    const p = predict(ctx, loadWarmerConfig());
    if (!p) {
      ctx.ui.setStatus("cache-warmth", undefined);
      return;
    }
    if (p.warm) {
      const min = Math.max(1, Math.round(p.deltaMs / 60_000));
      const label = min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m` : `${min}m`;
      ctx.ui.setStatus("cache-warmth", `🔥 ${label}`);
    } else {
      const k = p.estTokens >= 1000 ? `~${Math.round(p.estTokens / 1000)}k` : `${p.estTokens}`;
      ctx.ui.setStatus("cache-warmth", `❄ ${k} tok`);
    }
  };

  // keep the indicator fresh: any activity captures a ctx, a timer re-derives
  let timerStarted = false;
  const onActivity = async (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (!timerStarted) {
      timerStarted = true;
      ctx.setInterval(refreshIndicator, 30_000);
    }
    refreshIndicator();
  };
  pi.on("agent_start", onActivity);
  pi.on("agent_end", onActivity);
  pi.on("message_end", onActivity);
  pi.on("turn_end", onActivity);

  pi.on("input", async (event, ctx) => {
    lastCtx = ctx;
    if (event.source !== "interactive" || !ctx.hasUI) return;
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return;

    const cfg = loadWarmerConfig();
    if (cfg.missConfirmTokens === false) return;
    const threshold = cfg.missConfirmTokens ?? 40_000;

    const p = predict(ctx, cfg);
    if (!p) return;
    if (p.warm) return; // predicted warm — send freely
    if (p.estTokens < threshold) return; // cold but cheap — not worth interrupting

    const ok = await ctx.ui.confirm(
      "Predicted prompt-cache MISS",
      `This session has been idle ~${p.idleMin}m — its ${p.provider} cache entry has likely expired. ` +
        `Sending now will re-read ~${p.estTokens.toLocaleString()} tokens uncached (then re-prime the cache).\n\nSend anyway?`,
    );
    if (ok) return; // proceed with normal flow
    ctx.ui.setEditorText(event.text); // give the typed message back
    ctx.ui.notify("Message not sent (predicted cache miss).", "info");
    return { handled: true };
  });
}
