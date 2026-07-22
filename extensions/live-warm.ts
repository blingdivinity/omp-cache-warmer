import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Live self-warming: keeps an OPEN omp session's cache warm from inside the
 * process itself — the only prefix byte-identical to the next real request.
 *
 * Why: the external daemon warms the file-resume rendering; a live process
 * that idles past omp's prune idle-flush (90m) rewrites its own rendering and
 * misses anyway. A ping sent through the live pipeline + a session-tree
 * rewind (validated: post-rewind real message ~99% cached) fixes exactly that,
 * and resets the idle-flush clock as a side effect.
 *
 * Enable with `"liveWarm": true` in the shared config. The cycle needs a
 * command context (navigateTree/waitForIdle); one is stashed from any of our
 * command invocations — run /livewarm-on (or any ping) once per session.
 */

const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");
const LOG = join(DATA_DIR, "live-warm.log");

/** stop pinging before omp's PRUNE_IDLE_FLUSH_MS (90m): a ping after that would trigger the flush */
const IDLE_FLUSH_CUTOFF_MS = 88 * 60_000;

function logLine(msg: string) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

interface LiveWarmConfig {
  message?: string;
  liveWarm?: boolean;
  intervals?: Record<string, number>;
  defaultIntervalMinutes?: number;
  liveWarmIntervalMinutes?: number;
}

function loadCfg(): LiveWarmConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as LiveWarmConfig;
  } catch {
    return {};
  }
}

interface UsageShape {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export default function (pi: ExtensionAPI) {
  let lastAssistantUsage: UsageShape | undefined;
  let cmdCtx: ExtensionCommandContext | undefined;
  let lastActivity = Date.now();
  let cycling = false;

  const markWarmInSharedState = (ctx: ExtensionContext) => {
    // let the daemon know this lineage was just warmed so it backs off
    const id = ctx.sessionManager.getSessionId();
    if (!id) return;
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, { lastWarmAt?: string; misses?: number }>;
      state[id] = { ...(state[id] ?? { misses: 0 }), lastWarmAt: new Date().toISOString() };
      writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
    } catch {}
  };

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

  // ---- events: usage capture, activity clock, timer ----
  pi.on("message_end", async (event) => {
    const m = event.message as { role?: string; usage?: UsageShape };
    if (m.role === "assistant" && m.usage) lastAssistantUsage = m.usage;
  });

  let timerStarted = false;
  const ensureTimer = (ctx: ExtensionContext) => {
    if (timerStarted) return;
    timerStarted = true;
    ctx.setInterval(() => {
        void (async () => {
          const cfg = loadCfg();
          if (cfg.liveWarm !== true || !cmdCtx) return;
          const provider = cmdCtx.model?.provider;
          const intervalMs =
            (cfg.liveWarmIntervalMinutes ?? cfg.intervals?.[provider ?? ""] ?? cfg.defaultIntervalMinutes ?? 55) * 60_000;
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
  const onActivity = async (_event: unknown, ctx: ExtensionContext) => {
    if (!cycling) lastActivity = Date.now();
    ensureTimer(ctx);
    // auto-arm: the runtime may hand events the full command-capable context
    // even though the types declare the plain one — duck-type and use it.
    if (!cmdCtx) {
      const candidate = ctx as Partial<ExtensionCommandContext>;
      if (typeof candidate.navigateTree === "function" && typeof candidate.waitForIdle === "function") {
        cmdCtx = ctx as ExtensionCommandContext;
        logLine("auto-armed from event context (runtime exposes command surface)");
      }
    }
  };
  pi.on("agent_start", onActivity);
  pi.on("agent_end", onActivity);
  pi.on("turn_end", onActivity);

  // ---- commands ----
  pi.registerCommand("livewarm-on", {
    description: "Arm live self-warming for this session (requires \"liveWarm\": true in config)",
    handler: async (_args, ctx) => {
      cmdCtx = ctx;
      ensureTimer(ctx);
      lastActivity = Date.now();
      const cfg = loadCfg();
      if (ctx.hasUI) {
        ctx.ui.notify(
          cfg.liveWarm === true
            ? "Live self-warming armed: idle pings on the provider interval, auto-rewound."
            : 'Context armed, but "liveWarm" is not true in config — auto-pings stay off.',
          cfg.liveWarm === true ? "info" : "warning",
        );
      }
    },
  });

  pi.registerCommand("livewarm-ping", {
    description: "One live self-warm cycle now: ping through the real pipeline, then rewind",
    handler: async (_args, ctx) => {
      cmdCtx = ctx;
      await runCycle(ctx, "manual");
    },
  });
}
