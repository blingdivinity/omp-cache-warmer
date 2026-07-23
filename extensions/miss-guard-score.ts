/** Prediction-accuracy scoring: log every misfire to predictions.jsonl. */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./miss-guard-lib";

export interface StampedPrediction {
  warm: boolean;
  idleFlush: boolean;
  estTokens: number;
  ts: string;
}

export interface Scorer {
  /** record the prediction for the message about to be sent */
  stamp(pred: StampedPrediction): void;
  /** discard any pending prediction (e.g. before a live-warm ping) */
  clear(): void;
}

/** Registers a message_end hook that scores the next assistant usage against the stamped prediction. */
export function createScorer(pi: ExtensionAPI): Scorer {
  let pending: StampedPrediction | undefined;

  const recordOutcome = (u: { input?: number; cacheRead?: number; cacheWrite?: number }, ctx: ExtensionContext) => {
    const pred = pending;
    pending = undefined;
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
    if (m.role === "assistant" && m.usage && pending) recordOutcome(m.usage, ctx);
  });

  return {
    stamp: (pred) => {
      pending = pred;
    },
    clear: () => {
      pending = undefined;
    },
  };
}
