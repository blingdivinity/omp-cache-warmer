#!/usr/bin/env bun
/**
 * omp-cache-warmer — keeps oh-my-pi session prompt caches warm.
 *
 * Scans ~/.omp/agent/sessions for recently-used sessions and, on a
 * per-provider interval, re-sends each one's exact prompt prefix by resuming
 * a temporary copy of the session file (throwaway --session-dir, so real
 * history never grows). Every warm is verified via usage.cacheRead.
 *
 * Modules: config (paths/settings), scan (eligibility), warm (one ping),
 * sweep (decide+classify), status (views), service (launchd/systemd).
 */

import { readFileSync } from "node:fs";
import { CONFIG_PATH, loadConfig, log } from "./config";
import { installService, uninstallService } from "./service";
import { loadState, saveState } from "./state";
import { stats, status } from "./status";
import { sweep } from "./sweep";

async function daemon() {
  log(`omp-cache-warmer daemon started (window ${loadConfig().windowHours}h)`);
  while (true) {
    try {
      await sweep(loadConfig()); // config re-read every sweep: edits apply live
    } catch (e) {
      log(`sweep error: ${e}`);
    }
    await Bun.sleep(60_000);
  }
}

const HELP = `omp-cache-warmer — keep omp prompt caches warm

usage:
  omp-cache-warmer status            show sessions in the warm window (default)
  omp-cache-warmer once              run a single warm sweep
  omp-cache-warmer daemon            run forever (sweeps every minute)
  omp-cache-warmer warm <id>         force-warm one session now
  omp-cache-warmer enable <id>       re-enable a disabled session
  omp-cache-warmer install           install launchd agent (macOS) / systemd unit (Linux)
  omp-cache-warmer uninstall         remove the background service
  omp-cache-warmer stats             hit/miss ledger summary (history.jsonl)
  omp-cache-warmer config            show config path + contents`;

async function main() {
  const cfg = loadConfig();
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "daemon":
    case "run":
      await daemon();
      break;
    case "once":
      await sweep(cfg);
      break;
    case "warm":
      if (!arg) throw new Error("usage: omp-cache-warmer warm <session-id-prefix>");
      await sweep(cfg, { force: arg });
      break;
    case "status":
    case undefined:
      status(cfg);
      break;
    case "enable": {
      if (!arg) throw new Error("usage: omp-cache-warmer enable <session-id-prefix>");
      const state = loadState();
      for (const [id, st] of Object.entries(state)) {
        if (id.startsWith(arg)) {
          delete st.disabled;
          st.misses = 0;
        }
      }
      saveState(state);
      console.log("re-enabled");
      break;
    }
    case "install":
      installService();
      break;
    case "uninstall":
      uninstallService();
      break;
    case "stats":
      stats();
      break;
    case "config":
      console.log(CONFIG_PATH);
      console.log(readFileSync(CONFIG_PATH, "utf8"));
      break;
    default:
      console.log(HELP);
  }
}

main();
