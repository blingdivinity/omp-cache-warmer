import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { liveWarmBridge } from "../shared/bridge";
import { IDLE_FLUSH_WARN_MS, OMP_IDLE_FLUSH_MS, PING_SAFE_IDLE_MS, loadWarmerConfig, predict } from "./lib";
import { describeChangedPart } from "./diff";
import { createScorer } from "./score";

/**
 * Miss guard: predicts the prompt-cache state for this session with the same
 * TTL math as the warmer daemon.
 *
 *  - Status-bar indicator: "🔥 43m" (warm, time to expiry) or "❄ ~85k tok".
 *  - Large predicted-miss sends get a menu: warm-first / send / keep.
 *  - Every send's prediction is scored against the actual usage (see
 *    miss-guard-score.ts); misfires land in predictions.jsonl.
 */

export default function (pi: ExtensionAPI) {
  let lastCtx: ExtensionContext | undefined;
  // last time THIS process finished agent work (in-memory = live-lineage clock)
  let lastProcessActivity = Date.now();
  const scorer = createScorer(pi);

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
    // effective prediction: a known prefix change means a miss even on a warm cache
    const predictedHit = p.warm && !idleFlush && !p.prefixChanged;
    const stampNow = () =>
      scorer.stamp({ warm: p.warm && !p.prefixChanged, idleFlush, estTokens: p.estTokens, ts: new Date().toISOString() });
    if (predictedHit) {
      stampNow(); // predicted warm, no flush risk, prefix aligned — send freely, but score it
      return;
    }
    if (p.estTokens < threshold) {
      stampNow(); // predicted miss but cheap — not worth interrupting; still score it
      return;
    }

    const touchAgo = p.lastTouchAt.toLocaleTimeString();
    const PREFIX_WHY: Record<string, string> = {
      diverged:
        `WHY: the request PREFIX CHANGED while the session file did not — the warmer's last ping proved the cache ` +
        `holds an OLD rendering (this process, or an omp/extension update, rewrote the prompt/history). Your message ` +
        `sends the NEW rendering → miss regardless of cache warmth. /compact or a restart (omp -c) plus ` +
        `\`omp-cache-warmer warm <id>\` re-aligns the lineages.`,
      unstable:
        `WHY: the request PREFIX CHANGES on every render — the daemon saw two consecutive warms mismatch and ` +
        `auto-disabled warming (something injects churning content into the prompt: timestamps, directory tree, an ` +
        `extension). Until that source is pinned or removed, EVERY send re-reads the full prefix.`,
      "pin-refreshed":
        `WHY: this session's prompt pin was RE-CAPTURED after the cache was last warmed — the warm cache holds the ` +
        `old pinned prompt, your message sends the new one → one-time miss, then the fresh prefix re-primes and ` +
        `warming continues normally.`,
    };
    const changedPart = p.prefixChanged
      ? describeChangedPart(ctx.sessionManager.getSessionId() ?? "", ctx.getSystemPrompt(), p.prefixChanged.kind)
      : undefined;
    const reason = p.prefixChanged
      ? `${PREFIX_WHY[p.prefixChanged.kind]}\n\nWHAT CHANGED: ${changedPart}`
      : p.warm && idleFlush
        ? `WHY: the provider cache is actually WARM (last refreshed ${touchAgo} by ${p.touchSource}) — but THIS ` +
          `omp process has been idle ~${Math.round(processIdle / 60_000)}m, past omp's ` +
          `${Math.round(OMP_IDLE_FLUSH_MS / 60_000)}m idle-flush. On your next message omp rewrites the sent ` +
          `history in-place, so the request bytes no longer match the warmed prefix → guaranteed miss. ` +
          `Restarting the session (omp -c) re-renders from the file and WILL hit the warmed prefix instead.`
        : `WHY: ${p.provider} cache entries survive ~${p.aliveMin}m after their last refresh, and this session's ` +
          `was last refreshed ${touchAgo} by ${p.touchSource} — ${p.idleMin}m ago, ${p.idleMin - p.aliveMin}m past ` +
          `expiry.${cfg.coldReprime === "never" ? " (The warmer daemon doesn't revive expired caches: coldReprime=\"never\".)" : ""} Your next request ` +
          `re-reads the full prefix and re-primes a fresh cache entry.`;
    // "Warm first" is only offered when the ping itself would HIT: the cache
    // must still be warm AND this process must not have crossed omp's 90m
    // idle-flush line. Past either point, a ping pays the exact same full miss
    // the user's message would — offering to "warm" would be a lie.
    const pingWouldHit = p.warm && processIdle < PING_SAFE_IDLE_MS && !p.prefixChanged;
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
      stampNow(); // user sends into a predicted miss — score it too
      return; // proceed with normal flow
    }

    if (choice === WARM_SEND && liveWarmBridge.runPing) {
      ctx.ui.notify("Warming (live ping + rewind)…", "info");
      scorer.clear(); // don't score the ping's own usage
      const okPing = await liveWarmBridge.runPing();
      if (okPing) {
        // re-send the original message through the normal pipeline; source
        // will be "extension", so this handler won't re-fire on it. After a
        // successful ping the cache should be hot: predict hit and score it.
        scorer.stamp({ warm: true, idleFlush: false, estTokens: p.estTokens, ts: new Date().toISOString() });
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
