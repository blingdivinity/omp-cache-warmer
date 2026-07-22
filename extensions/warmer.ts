import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Thin companion extension for pi-cache-warmer (the standalone daemon).
 * Adds /warm-status and /warm-off inside omp. The daemon does the real work
 * so warming keeps happening after you close this session.
 */

const DATA_DIR = join(homedir(), ".omp", "agent", "pi-cache-warmer");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const STATE_PATH = join(DATA_DIR, "state.json");

interface WarmState {
  lastWarmAt?: string;
  lastCacheRead?: number;
  misses: number;
  disabled?: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("warm-status", {
    description: "Show pi-cache-warmer status for this session",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      const id = ctx.sessionManager.getSessionId() ?? "";
      let state: Record<string, WarmState> = {};
      try {
        state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Record<string, WarmState>;
      } catch {}
      const st = state[id];
      if (!existsSync(DATA_DIR)) {
        ctx.ui.notify("pi-cache-warmer has never run. Start it: pi-cache-warmer install", "warning");
        return;
      }
      if (!st?.lastWarmAt) {
        ctx.ui.notify("This session has not been warmed yet (daemon warms after the provider interval elapses).", "info");
        return;
      }
      const ago = Math.round((Date.now() - Date.parse(st.lastWarmAt)) / 60000);
      const flag = st.disabled ? ` — DISABLED: ${st.disabled}` : "";
      ctx.ui.notify(`Last warmed ${ago}m ago, cacheRead=${st.lastCacheRead ?? "?"} tokens${flag}`, st.disabled ? "warning" : "info");
    },
  });

  pi.registerCommand("warm-off", {
    description: "Exclude this session from pi-cache-warmer",
    handler: async (_args, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      if (!id) return;
      mkdirSync(DATA_DIR, { recursive: true });
      let cfg: Record<string, unknown> & { exclude?: string[] } = {};
      try {
        cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown> & { exclude?: string[] };
      } catch {}
      cfg.exclude = [...new Set([...(cfg.exclude ?? []), id])];
      writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
      ctx.ui.notify("Session excluded from cache warming.", "info");
    },
  });
}
