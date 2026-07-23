import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { statSync } from "node:fs";
import { IDLE_FLUSH_CUTOFF_MS, intervalMsFor, loadCfg, logLine, markWarmInSharedState, type UsageShape } from "./lib";
import { liveWarmBridge } from "../shared/bridge";

/**
 * Live self-warming: keeps an OPEN omp session's cache warm from inside the
 * process itself — the only prefix byte-identical to the next real request.
 *
 * Why: the external daemon warms the file-resume rendering; a live process
 * that idles past omp's prune idle-flush (90m) rewrites its own rendering and
 * misses anyway. A ping sent through the live pipeline + a session-tree
 * rewind (validated: post-rewind real message ~99% cached) fixes exactly
 * that, and resets the idle-flush clock as a side effect.
 *
 * Enable with `"liveWarm": true` in the shared config; arm each session with
 * /livewarm-on (the cycle needs a command context for navigateTree).
 */

export default function (pi: ExtensionAPI) {
  let lastAssistantUsage: UsageShape | undefined;
  let cmdCtx: ExtensionCommandContext | undefined;
  let lastActivity = Date.now();
  let cycling = false;

  pi.on("message_end", async (event) => {
    const m = event.message as { role?: string; usage?: UsageShape };
    if (m.role === "assistant" && m.usage) lastAssistantUsage = m.usage;
  });

  const runCycle = async (ctx: ExtensionCommandContext, tag: string): Promise<void> => {
    if (cycling) return;
    cycling = true;
    try {
      const cfg = loadCfg();
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        logLine(`[${tag}] skipped: agent busy or pending messages`);
        return;
      }
      const leaf = ctx.sessionManager.getLeafEntry() as { id?: string } | undefined;
      if (!leaf?.id) {
        logLine(`[${tag}] skipped: no leaf entry`);
        return;
      }
      logLine(`[${tag}] ping start; leaf=${leaf.id}`);
      pi.sendUserMessage(cfg.message ?? "Respond with only: OK");
      try {
        // sendUserMessage is fire-and-forget: wait for the turn to start
        const t0 = Date.now();
        while (ctx.isIdle() && Date.now() - t0 < 15_000) {
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, 100);
          await promise;
        }
        if (ctx.isIdle()) throw new Error("ping turn never started");
        await ctx.waitForIdle();
      } finally {
        const u = lastAssistantUsage;
        const total = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
        logLine(`[${tag}] ping done; read=${u?.cacheRead ?? "?"} write=${u?.cacheWrite ?? "?"} total=${total} — rewinding`);
        const res = await ctx.navigateTree(leaf.id);
        logLine(`[${tag}] rewind ${res.cancelled ? "CANCELLED" : "ok"}`);
        markWarmInSharedState(ctx);
        if (ctx.hasUI) {
          const pct = total > 0 ? (((u?.cacheRead ?? 0) / total) * 100).toFixed(1) : "?";
          ctx.ui.setStatus("live-warm", `♨ pinged ${new Date().toLocaleTimeString()} (${pct}% cached)`);
        }
      }
    } finally {
      cycling = false;
    }
  };

  let timerStarted = false;
  const ensureTimer = (ctx: ExtensionContext) => {
    if (timerStarted) return;
    timerStarted = true;
    ctx.setInterval(() => {
      void (async () => {
        const cfg = loadCfg();
        if (cfg.liveWarm !== true || !cmdCtx) return;
        const intervalMs = intervalMsFor(cfg, cmdCtx.model?.provider);
        const idle = Date.now() - lastActivity;
        if (idle < intervalMs) return; // recently active — cache warm on its own
        if (idle > IDLE_FLUSH_CUTOFF_MS) {
          logLine(`skipping auto-ping: idle ${Math.round(idle / 60_000)}m past flush cutoff (would trigger the flush)`);
          return;
        }
        await runCycle(cmdCtx, "auto");
        lastActivity = Date.now();
      })();
    }, 60_000);
  };

  const armBridge = (ctx: ExtensionCommandContext) => {
    cmdCtx = ctx;
    liveWarmBridge.runPing = async () => {
      if (!cmdCtx) return false;
      try {
        await runCycle(cmdCtx, "miss-guard");
        return true;
      } catch (e) {
        logLine(`bridge ping failed: ${e}`);
        return false;
      }
    };
  };

  const onActivity = async (_event: unknown, ctx: ExtensionContext) => {
    if (!cycling) lastActivity = Date.now();
    ensureTimer(ctx);
    // auto-arm: the runtime may hand events the full command-capable context
    // even though the types declare the plain one — duck-type and use it.
    if (!cmdCtx) {
      const candidate = ctx as Partial<ExtensionCommandContext>;
      if (typeof candidate.navigateTree === "function" && typeof candidate.waitForIdle === "function") {
        armBridge(ctx as ExtensionCommandContext);
        logLine("auto-armed from event context (runtime exposes command surface)");
      }
    }
  };
  pi.on("agent_start", onActivity);
  pi.on("agent_end", onActivity);
  pi.on("turn_end", onActivity);

  pi.registerCommand("livewarm-on", {
    description: 'Arm live self-warming for this session (requires "liveWarm": true in config)',
    handler: async (_args, ctx) => {
      armBridge(ctx);
      ensureTimer(ctx);
      const cfg = loadCfg();
      // Derive REAL last activity from the session file's mtime — arming must
      // not fake a fresh idle clock, or the first ping lands after cache expiry.
      let derived = Date.now();
      try {
        const file = ctx.sessionManager.getSessionFile?.();
        if (file) derived = statSync(file).mtimeMs;
      } catch {
        derived = Date.now();
      }
      lastActivity = derived;

      const intervalMs = intervalMsFor(cfg, ctx.model?.provider);
      const idle = Date.now() - lastActivity;
      const idleMin = Math.round(idle / 60_000);
      let armPinged = false;

      if (cfg.liveWarm === true && idle >= intervalMs && idle <= IDLE_FLUSH_CUTOFF_MS) {
        armPinged = true;
        void runCycle(ctx, "arm")
          .then(() => {
            lastActivity = Date.now();
          })
          .catch((e) => {
            logLine(`[arm] immediate arm-ping failed: ${e}`);
          });
      } else if (cfg.liveWarm === true && idle > IDLE_FLUSH_CUTOFF_MS) {
        logLine(`[arm] armed too late: idle ${idleMin}m past flush cutoff — no safe ping possible`);
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Live-warm armed, but this session has been idle ${idleMin}m — past the safe window. ` +
              "The next real send will likely miss cache. Send a cheap message now (or `omp -c`) to reprime.",
            "warning",
          );
        }
      }

      logLine(
        `[arm] armed: idle=${idleMin}m intervalMs=${intervalMs} liveWarm=${cfg.liveWarm === true} armPing=${armPinged}`,
      );

      if (ctx.hasUI) {
        ctx.ui.notify(
          cfg.liveWarm === true
            ? armPinged
              ? "Live self-warming armed: session was stale — pinging now, then idle pings on the provider interval."
              : "Live self-warming armed: idle pings on the provider interval, auto-rewound."
            : 'Context armed, but "liveWarm" is not true in config — auto-pings stay off.',
          cfg.liveWarm === true ? "info" : "warning",
        );
      }
    },
  });

  pi.registerCommand("livewarm-ping", {
    description: "One live self-warm cycle now: ping through the real pipeline, then rewind",
    handler: async (_args, ctx) => {
      armBridge(ctx);
      ensureTimer(ctx);
      await runCycle(ctx, "manual");
    },
  });
}
