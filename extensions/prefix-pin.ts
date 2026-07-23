import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, utimesSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { toolsFingerprint } from "./shared/omp-config";

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
const PREFLIGHT_LOG = join(DATA_DIR, "preflight.log");

interface Pin {
  createdAt: string;
  systemPrompt: string[];
}

interface RenderSlot {
  ts: string;
  hash: string;
  chars: number;
  toolsFp?: string;
}

interface RenderSidecar {
  live?: RenderSlot;
  warm?: RenderSlot;
}

// The render-hash sidecar is pre-flight drift instrumentation. Both the live
// interactive session and the omp-cache-warmer daemon (warm mode) hash their
// EFFECTIVE system prompt into PINS_DIR/<id>.render.json. In warm mode, a live
// hash that disagrees with ours means the daemon renders a different system
// prompt than the session — the paid warm would full-miss, so we abort at exit
// 93 (0 tokens) before sending anything.
//
// NOTE: equal hashes here but a paid 0/N miss later proves the divergence lives
// OUTSIDE the system prompt (tool schemas / message rendering) — upstream-pin
// territory an extension cannot fix. This sidecar is exactly what distinguishes
// the two cases: system-prompt drift (caught free here) vs. everything else.
function updateRenderSidecar(id: string, warmMode: boolean, effectivePrompt: string[], toolsFp: string | undefined) {
  const hash = createHash("sha256").update(JSON.stringify(effectivePrompt)).digest("hex").slice(0, 16);
  const chars = JSON.stringify(effectivePrompt).length;
  const sidecarPath = join(PINS_DIR, `${id}.render.json`);
  let sidecar: RenderSidecar = {};
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, "utf8")) as RenderSidecar;
  } catch {}
  if (warmMode && sidecar.live) {
    const hashMismatch = sidecar.live.hash !== hash;
    // tool schemas sit ahead of the system prompt in the request, so a changed
    // tool set is just as fatal to the cached prefix as a changed prompt. Only
    // compare when BOTH sides carry a fingerprint (older omp → undefined → skip).
    const toolsMismatch = !!toolsFp && !!sidecar.live.toolsFp && sidecar.live.toolsFp !== toolsFp;
    if (hashMismatch || toolsMismatch) {
      const what = hashMismatch ? "system prompt changed" : "tools changed";
      const detail = hashMismatch
        ? `warm hash ${hash} != live hash ${sidecar.live.hash}`
        : `warm toolsFp ${toolsFp} != live toolsFp ${sidecar.live.toolsFp}`;
      try {
        appendFileSync(
          PREFLIGHT_LOG,
          `[${new Date().toISOString()}] ${id.slice(0, 8)} pre-flight drift (${what}): ` +
            `${detail} (live ts ${sidecar.live.ts}) — aborting warm, 0 tokens\n`,
        );
      } catch {}
      process.exit(93);
    }
  }
  const slot: RenderSlot = { ts: new Date().toISOString(), hash, chars, toolsFp };
  if (warmMode) sidecar.warm = slot;
  else sidecar.live = slot;
  try {
    mkdirSync(PINS_DIR, { recursive: true });
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  } catch {}
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

    const warmMode = process.env.OMP_CACHE_WARMER_WARM === "1";
    const toolsFp = toolsFingerprint(ctx);
    if (pin) {
      // replay the frozen prompt byte-for-byte — pins never expire, so every
      // resumed session keeps its original prefix even after the cache went
      // cold (a cold resume then re-primes the SAME stable prefix).
      try {
        const t = new Date();
        utimesSync(pinPath, t, t); // mark as in-use for the 60-day pruner
      } catch {}
      // may process.exit(93) in warm mode if our replay diverges from live
      updateRenderSidecar(id, warmMode, pin.systemPrompt, toolsFp);
      return { systemPrompt: pin.systemPrompt };
    }
    // first turn of this session: capture the rendered prompt as the pin
    mkdirSync(PINS_DIR, { recursive: true });
    writeFileSync(
      pinPath,
      JSON.stringify({ createdAt: new Date().toISOString(), systemPrompt: event.systemPrompt } satisfies Pin, null, 2),
    );
    // may process.exit(93) in warm mode if this fresh capture diverges from live
    updateRenderSidecar(id, warmMode, event.systemPrompt, toolsFp);
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
      // archive instead of delete so miss-guard can diff old vs new prompt
      try {
        renameSync(join(PINS_DIR, `${id}.json`), join(PINS_DIR, `${id}.prev.json`));
      } catch {}
      if (ctx.hasUI) ctx.ui.notify("Pin dropped — next turn captures and pins the current prompt.", "info");
    },
  });
}
