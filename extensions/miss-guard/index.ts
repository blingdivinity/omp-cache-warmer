import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { PrefixChange } from "./lib";
import { liveWarmBridge } from "../shared/bridge";
import { ompIdleFlushDisabled, toolsFingerprint } from "../shared/omp-config";
import { IDLE_FLUSH_WARN_MS, OMP_IDLE_FLUSH_MS, PING_SAFE_IDLE_MS, loadWarmerConfig, predict, readLiveToolsFp } from "./lib";
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

  // The tool set + omp version form the one prefix component prefix-pin.ts
  // cannot freeze. predict() has no clean tool access, so we detect drift here:
  // when the prediction shows no other prefix change, compare the live ctx's
  // fingerprint against the one prefix-pin stored in the render sidecar. Both
  // present and different ⇒ the cached prefix cannot match. Cheap (one small
  // JSON read), safe to run at the 30s indicator cadence.
  const flagToolsChange = (ctx: ExtensionContext, p: { prefixChanged?: { kind: PrefixChange["kind"]; detail: string } }) => {
    if (p.prefixChanged) return;
    const id = ctx.sessionManager.getSessionId();
    if (!id) return;
    const current = toolsFingerprint(ctx);
    const stored = readLiveToolsFp(id);
    if (current && stored && current !== stored) {
      p.prefixChanged = {
        kind: "tools-changed",
        detail:
          "active tool set changed since the last request (omp upgrade / extension change / tool toggle) — the cached prefix cannot match",
      };
    }
  };

  const refreshIndicator = () => {
    const ctx = lastCtx;
    if (!ctx?.hasUI) return;
    const p = predict(ctx, loadWarmerConfig());
    if (!p) {
      ctx.ui.setStatus("cache-warmth", undefined);
      return;
    }
    flagToolsChange(ctx, p);
    const idleFlush = !ompIdleFlushDisabled() && Date.now() - lastProcessActivity > IDLE_FLUSH_WARN_MS;
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
    flagToolsChange(ctx, p);
    const processIdle = Date.now() - lastProcessActivity;
    const idleFlush = !ompIdleFlushDisabled() && processIdle > IDLE_FLUSH_WARN_MS;
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
      diverged: `WHY: prefix changed (cache holds an old rendering). Fix: /compact or omp -c, then omp-cache-warmer warm <id>.`,
      unstable: `WHY: prefix changes every render (churning prompt content) — warming auto-disabled; every send re-reads.`,
      "pin-refreshed": `WHY: prompt pin re-captured after last warm — one-time miss, then warming resumes.`,
      "warm-missed": `WHY: the warmer's last ping itself missed and re-primed a NEW rendering — this live session's bytes likely differ; expect a full re-read. Fix: send (re-primes live prefix) or /livewarm-ping.`,
      "tools-changed": `WHY: the active tool schemas changed (omp upgrade / extension change / tool toggle). Tool definitions precede everything else in the prompt, so the WHOLE prefix re-reads — a one-time miss. Next turn re-primes the new prefix. Fix: just send.`,
    };
    const changedPart = p.prefixChanged
      ? describeChangedPart(ctx.sessionManager.getSessionId() ?? "", ctx.getSystemPrompt(), p.prefixChanged.kind)
      : undefined;
    const reason = p.prefixChanged
      ? `${PREFIX_WHY[p.prefixChanged.kind]}\n\nWHAT CHANGED: ${changedPart}`
      : p.warm && idleFlush
        ? `WHY: cache is warm (refreshed ${touchAgo} by ${p.touchSource}), but this process idled ` +
          `${Math.round(processIdle / 60_000)}m > omp's ${Math.round(OMP_IDLE_FLUSH_MS / 60_000)}m idle-flush → omp ` +
          `rewrites history on send → miss. omp -c would hit instead.`
        : `WHY: ${p.provider} cache lives ~${p.aliveMin}m; last refreshed ${touchAgo} by ${p.touchSource}, ` +
          `${p.idleMin - p.aliveMin}m past expiry${cfg.coldReprime === "never" ? " (daemon never revives cold caches)" : ""}.`;
    // "Warm first" is only offered when the ping itself would HIT: the cache
    // must still be warm AND this process must not have crossed omp's 90m
    // idle-flush line. Past either point, a ping pays the exact same full miss
    // the user's message would — offering to "warm" would be a lie.
    const pingWouldHit = p.warm && (ompIdleFlushDisabled() || processIdle < PING_SAFE_IDLE_MS) && !p.prefixChanged;
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
