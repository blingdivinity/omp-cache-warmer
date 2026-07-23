import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { liveWarmBridge } from "./livewarm-shared";

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

/**
 * omp's prune/supersede pass flushes+rewrites the whole sent history when THIS
 * PROCESS has been idle longer than PRUNE_IDLE_FLUSH_MS (90m upstream), on the
 * assumption the provider cache is cold. An external warmer breaks that
 * assumption: the cache is warm, but the rewritten request misses it anyway.
 * We warn slightly early (85m) so the user sends before the flush window.
 */
const OMP_IDLE_FLUSH_MS = 90 * 60_000;
const IDLE_FLUSH_WARN_MS = 85 * 60_000;

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  // last time THIS process finished agent work (in-memory = live-lineage clock)
  let lastProcessActivity = Date.now();
  /** prediction made when a user message was released, awaiting its actual usage */
  let pendingPrediction: { warm: boolean; idleFlush: boolean; estTokens: number; ts: string } | undefined;

  const recordOutcome = (u: { input?: number; cacheRead?: number; cacheWrite?: number }, ctx: ExtensionContext) => {
    const pred = pendingPrediction;
    pendingPrediction = undefined;
    if (!pred) return;
    const total = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
    if (total < 1000) return; // aborted/trivial request — no verdict
    const actualHit = (u.cacheRead ?? 0) / total >= 0.5;
    const predictedHit = pred.warm && !pred.idleFlush;
    if (actualHit === predictedHit) return; // prediction correct — stay quiet
    const entry = {
      ts: new Date().toISOString(),
      session: ctx.sessionManager.getSessionId() ?? "?",
      predicted: predictedHit ? "hit" : "miss",
      actual: actualHit ? "hit" : "miss",
      idleFlushFlag: pred.idleFlush,
      estTokens: pred.estTokens,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      total,
    };
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(join(DATA_DIR, "predictions.jsonl"), JSON.stringify(entry) + "\n");
    } catch {}
    if (ctx.hasUI) {
      ctx.ui.notify(
        predictedHit
          ? `Cache prediction WRONG: expected hit, got miss (${entry.cacheRead}/${total} cached) — logged.`
          : `Cache prediction wrong (good news): expected miss, got hit (${entry.cacheRead}/${total} cached) — logged.`,
        predictedHit ? "warning" : "info",
      );
    }
  };

  pi.on("message_end", async (event, ctx) => {
    const m = event.message as { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } };
    if (m.role === "assistant" && m.usage && pendingPrediction) recordOutcome(m.usage, ctx);
  });

  const refreshIndicator = () => {
    const ctx = lastCtx;
    if (!ctx?.hasUI) return;
    const p = predict(ctx, loadWarmerConfig());
    if (!p) {
      ctx.ui.setStatus("cache-warmth", undefined);
      return;
    }
    const idleFlush = Date.now() - lastProcessActivity > IDLE_FLUSH_WARN_MS;
    if (p.warm && !idleFlush) {
      const min = Math.max(1, Math.round(p.deltaMs / 60_000));
      const label = min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m` : `${min}m`;
      ctx.ui.setStatus("cache-warmth", `🔥 ${label}`);
    } else {
      const k = p.estTokens >= 1000 ? `~${Math.round(p.estTokens / 1000)}k` : `${p.estTokens}`;
      ctx.ui.setStatus("cache-warmth", p.warm ? `❄ ${k} tok (idle-flush)` : `❄ ${k} tok`);
    }
  };

  // keep the indicator fresh: any activity captures a ctx, a timer re-derives
  let timerStarted = false;
  const onActivity = async (_event: unknown, ctx: ExtensionContext) => {
    lastCtx = ctx;
    lastProcessActivity = Date.now();
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
    const processIdle = Date.now() - lastProcessActivity;
    const idleFlush = processIdle > IDLE_FLUSH_WARN_MS;
    if (p.warm && !idleFlush) {
      // predicted warm, no flush risk — send freely, but score the prediction
      pendingPrediction = { warm: p.warm, idleFlush, estTokens: p.estTokens, ts: new Date().toISOString() };
      return;
    }
    if (p.estTokens < threshold) {
      // cold but cheap — not worth interrupting; still score it
      pendingPrediction = { warm: p.warm, idleFlush, estTokens: p.estTokens, ts: new Date().toISOString() };
      return;
    }

    const reason =
      p.warm && idleFlush
        ? `The cache is warm (the warmer daemon kept it alive), but THIS omp process has been idle ` +
          `~${Math.round(processIdle / 60_000)}m — past omp's ${Math.round(OMP_IDLE_FLUSH_MS / 60_000)}m idle-flush, ` +
          `so omp will rewrite the sent history and miss the warm cache anyway. ` +
          `Restarting the session (omp -c) re-renders from the file and WILL hit the warmed prefix.`
        : `This session has been idle ~${p.idleMin}m — its ${p.provider} cache entry has likely expired.`;
    // "Warm first" is only offered when the ping itself would HIT: the cache
    // must still be warm AND this process must not have crossed omp's 90m
    // idle-flush line (use live-warm's 88m safety cutoff). Past either point,
    // a ping pays the exact same full miss the user's message would — offering
    // to "warm" would be a lie.
    const pingWouldHit = p.warm && processIdle < 88 * 60_000;
    const canLiveWarm = typeof liveWarmBridge.runPing === "function" && pingWouldHit;
    const SEND = "Send now";
    const WARM_SEND = "Warm first, then send";
    const KEEP = "Don't send (keep message)";
    const options = [
      ...(canLiveWarm
        ? [{ label: WARM_SEND, description: "cache is still warm: ping hits, resets the idle-flush clock, then your message sends hot" }]
        : []),
      { label: SEND, description: `pay the ~${p.estTokens.toLocaleString()}-token re-read now (re-primes the cache)` },
      {
        label: KEEP,
        description: canLiveWarm ? "message stays in the editor" : "message stays in the editor — tip: /livewarm-on prevents this",
      },
    ];
    ctx.ui.notify(reason, "warning");
    const choice = await ctx.ui.select("Predicted prompt-cache MISS", options);
    if (choice === SEND) {
      // user sends into a predicted miss — score it too
      pendingPrediction = { warm: p.warm, idleFlush, estTokens: p.estTokens, ts: new Date().toISOString() };
      return; // proceed with normal flow
    }

    if (choice === WARM_SEND && liveWarmBridge.runPing) {
      ctx.ui.notify("Warming (live ping + rewind)…", "info");
      pendingPrediction = undefined; // don't score the ping's own usage
      const okPing = await liveWarmBridge.runPing();
      if (okPing) {
        // re-send the original message through the normal pipeline; source
        // will be "extension", so this handler won't re-fire on it. After a
        // successful ping the cache should be hot: predict hit and score it.
        pendingPrediction = { warm: true, idleFlush: false, estTokens: p.estTokens, ts: new Date().toISOString() };
        pi.sendUserMessage(event.text);
        return { handled: true };
      }
      ctx.ui.notify("Live-warm failed — message kept in editor.", "warning");
    }

    // KEEP (or cancel/failure): the runtime clears the editor draft AFTER a
    // handler returns handled:true (dist: `if (K?.handled) {
    // this.ctx.editor.clearDraft(); return }`), so a synchronous setEditorText
    // gets wiped. Defer the restore past the clear via the managed timer.
    ctx.setTimeout(() => {
      ctx.ui.setEditorText(event.text);
    }, 50);
    ctx.ui.notify("Message not sent (predicted cache miss).", "info");
    return { handled: true };
  });
}
