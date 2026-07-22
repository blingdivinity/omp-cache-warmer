import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Prefix pinning: freezes a session's rendered system prompt on first use and
 * replays it byte-for-byte on every subsequent turn — interactive resumes AND
 * omp-cache-warmer pings alike. This removes prompt drift (date rollover,
 * directory-tree changes, omp prompt tweaks) as a cache-miss source.
 *
 * Tool schemas are the one prefix component an extension cannot pin; those
 * only change on omp version bumps (see README "Upstream" note).
 */

const DATA_DIR = join(homedir(), ".omp", "agent", "omp-cache-warmer");
const PINS_DIR = join(DATA_DIR, "pins");
const CONFIG_PATH = join(DATA_DIR, "config.json");

interface Pin {
  createdAt: string;
  systemPrompt: string[];
}

export default function (pi: ExtensionAPI) {
  // Warming is pointless if interactive sessions write 5-minute cache entries
  // (omp's default tier). omp reads this env live per-request (Bun.env), so
  // setting it at plugin load upgrades every session to 1h-TTL entries.
  // Respect an explicit user choice if one is already set.
  process.env.PI_CACHE_RETENTION ??= "long";

  pi.on("before_agent_start", async (event, ctx) => {
    let cfg: { pinPrefixes?: boolean } = {};
    try {
      cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { pinPrefixes?: boolean };
    } catch {}
    if (cfg.pinPrefixes === false) return;

    const id = ctx.sessionManager.getSessionId();
    if (!id) return;
    const pinPath = join(PINS_DIR, `${id}.json`);

    let pin: Pin | undefined;
    try {
      pin = JSON.parse(readFileSync(pinPath, "utf8")) as Pin;
    } catch {}

    if (pin) {
      // replay the frozen prompt byte-for-byte — pins never expire, so every
      // resumed session keeps its original prefix even after the cache went
      // cold (a cold resume then re-primes the SAME stable prefix).
      try {
        const t = new Date();
        utimesSync(pinPath, t, t); // mark as in-use for the 60-day pruner
      } catch {}
      return { systemPrompt: pin.systemPrompt };
    }
    // first turn of this session: capture the rendered prompt as the pin
    mkdirSync(PINS_DIR, { recursive: true });
    writeFileSync(
      pinPath,
      JSON.stringify({ createdAt: new Date().toISOString(), systemPrompt: event.systemPrompt } satisfies Pin, null, 2),
    );
  });

  pi.registerCommand("pin-status", {
    description: "Show whether this session's prompt prefix is pinned",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const id = ctx.sessionManager.getSessionId() ?? "";
      const pinPath = join(PINS_DIR, `${id}.json`);
      if (!existsSync(pinPath)) {
        ctx.ui.notify("No pin yet — the prompt is captured on the next turn.", "info");
        return;
      }
      try {
        const pin = JSON.parse(readFileSync(pinPath, "utf8")) as Pin;
        const ageH = ((Date.now() - Date.parse(pin.createdAt)) / 3_600_000).toFixed(1);
        const chars = pin.systemPrompt.reduce((n, s) => n + s.length, 0);
        ctx.ui.notify(`Prefix pinned ${ageH}h ago (${chars} chars, ~${Math.round(chars / 4)} tokens).`, "info");
      } catch {
        ctx.ui.notify("Pin file unreadable.", "warning");
      }
    },
  });

  pi.registerCommand("pin-refresh", {
    description: "Drop this session's prefix pin so the next turn re-captures a fresh prompt",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      if (!id) return;
      rmSync(join(PINS_DIR, `${id}.json`), { force: true });
      if (ctx.hasUI) ctx.ui.notify("Pin dropped — next turn captures and pins the current prompt.", "info");
    },
  });
}
