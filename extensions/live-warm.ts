import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Live self-warming prototype (experiment #6 harness).
 *
 * The external warmer daemon cannot protect an OPEN omp process that idles
 * past omp's prune idle-flush (90m): the flush rewrites the live rendering,
 * so the daemon's file-resume lineage no longer matches. The only prefix
 * that is byte-identical to the live process's next request is one produced
 * BY the live process. So: send a real ping turn through the full pipeline,
 * then rewind the session tree to the pre-ping leaf.
 *
 * /livewarm-ping runs one ping+rewind cycle and reports the ping's cache hit.
 * The automated timer stays behind config `liveWarm` (default OFF) until the
 * rewind-fidelity experiment passes.
 */

const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const LOG = join(DATA_DIR, "live-warm.log");

function logLine(msg: string) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

interface UsageShape {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export default function (pi: ExtensionAPI) {
  let lastAssistantUsage: UsageShape | undefined;
  pi.on("message_end", async (event) => {
    const m = event.message as { role?: string; usage?: UsageShape };
    if (m.role === "assistant" && m.usage) lastAssistantUsage = m.usage;
  });

  pi.registerCommand("livewarm-ping", {
    description: "One live self-warm cycle: ping the model through the real pipeline, then rewind",
    handler: async (_args, ctx) => {
      let cfg: { message?: string } = {};
      try {
        cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { message?: string };
      } catch {}

      if (!ctx.isIdle()) {
        if (ctx.hasUI) ctx.ui.notify("Agent busy — not pinging.", "warning");
        return;
      }
      const leaf = ctx.sessionManager.getLeafEntry() as { id?: string } | undefined;
      if (!leaf?.id) {
        if (ctx.hasUI) ctx.ui.notify("No leaf entry (empty session?) — not pinging.", "warning");
        return;
      }

      logLine(`ping start; leaf=${leaf.id}`);
      pi.sendUserMessage(cfg.message ?? "Respond with only: OK");
      try {
        // sendUserMessage is fire-and-forget: wait for the turn to actually
        // start (agent leaves idle) before waiting for it to finish
        const t0 = Date.now();
        while (ctx.isIdle() && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 100));
        if (ctx.isIdle()) throw new Error("ping turn never started");
        await ctx.waitForIdle();
      } finally {
        // rewind defensively even if the ping errored
        const u = lastAssistantUsage;
        const total = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
        logLine(
          `ping done; usage read=${u?.cacheRead ?? "?"} write=${u?.cacheWrite ?? "?"} total=${total} — rewinding to ${leaf.id}`,
        );
        const res = await ctx.navigateTree(leaf.id);
        logLine(`rewind ${res.cancelled ? "CANCELLED" : "ok"}`);
        if (ctx.hasUI) {
          const pct = total > 0 ? (((u?.cacheRead ?? 0) / total) * 100).toFixed(1) : "?";
          ctx.ui.notify(`live-warm: ping cached ${pct}% (${u?.cacheRead ?? 0}/${total}), rewound to pre-ping leaf.`, "info");
        }
      }
    },
  });
}
