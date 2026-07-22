import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Miss guard: before a user message is sent, predict whether the prompt cache
 * for this session is already expired (same TTL math as the warmer daemon).
 * If a miss is predicted and the prefix is large, pop a yes/no confirmation
 * so an expensive cold re-read is never a surprise.
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

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" || !ctx.hasUI) return;
    const text = event.text.trim();
    if (!text || text.startsWith("/") || text.startsWith("!")) return;

    let cfg: WarmerConfig = {};
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WarmerConfig;
    } catch {}
    if (cfg.missConfirmTokens === false) return;
    const threshold = cfg.missConfirmTokens ?? 40_000;

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
    if (lastTouch === 0) return; // brand-new session: nothing cached yet, nothing to warn about

    const aliveMs = intervalMs + 10 * 60_000;
    if (Date.now() - lastTouch < aliveMs) return; // predicted warm — send freely
    if (estTokens < threshold) return; // cold but cheap — not worth interrupting

    const idleMin = Math.round((Date.now() - lastTouch) / 60_000);
    const ok = await ctx.ui.confirm(
      "Predicted prompt-cache MISS",
      `This session has been idle ~${idleMin}m — its ${provider} cache entry has likely expired. ` +
        `Sending now will re-read ~${estTokens.toLocaleString()} tokens uncached (then re-prime the cache).\n\nSend anyway?`,
    );
    if (ok) return; // proceed with normal flow
    ctx.ui.setEditorText(event.text); // give the typed message back
    ctx.ui.notify("Message not sent (predicted cache miss).", "info");
    return { handled: true };
  });
}
