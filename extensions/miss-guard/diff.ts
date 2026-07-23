/** Pinpoint exactly where two rendered system prompts diverge. */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./lib";

const CONTEXT = 60;

/** First divergence between two prompt renders, with quoted context — or undefined if identical. */
export function describePromptDiff(pinned: string[], current: string[]): string | undefined {
  if (pinned.length !== current.length) {
    return `system prompt block count changed: ${pinned.length} → ${current.length} blocks (an extension or omp update added/removed a prompt section)`;
  }
  for (let b = 0; b < pinned.length; b++) {
    const a = pinned[b];
    const c = current[b];
    if (a === c) continue;
    let i = 0;
    while (i < a.length && i < c.length && a[i] === c[i]) i++;
    const from = a.slice(Math.max(0, i - CONTEXT), i + CONTEXT).replace(/\n/g, "⏎");
    const to = c.slice(Math.max(0, i - CONTEXT), i + CONTEXT).replace(/\n/g, "⏎");
    return `system prompt block ${b + 1}/${pinned.length} changed at char ${i}:\n  cached: “…${from}…”\n  now:    “…${to}…”`;
  }
  return undefined;
}

interface Pin {
  systemPrompt?: string[];
}

/** Load a pin (current or archived .prev) for a session id. */
export function loadPin(id: string, prev = false): string[] | undefined {
  try {
    const file = join(DATA_DIR, "pins", `${id}${prev ? ".prev" : ""}.json`);
    const pin = JSON.parse(readFileSync(file, "utf8")) as Pin;
    return Array.isArray(pin.systemPrompt) ? pin.systemPrompt : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort description of WHAT part of the prefix changed, given the
 * session's pin state and the currently rendered prompt.
 */
export function describeChangedPart(id: string, current: string[], kind: string): string {
  if (kind === "pin-refreshed") {
    const prev = loadPin(id, true);
    if (prev) {
      const d = describePromptDiff(prev, current);
      if (d) return d;
    }
    return "the pinned system prompt was re-captured (previous pin not retained for diffing)";
  }
  const pinned = loadPin(id);
  const d = pinned ? describePromptDiff(pinned, current) : undefined;
  if (d) return d;
  return (
    "system prompt is unchanged (pinned) — the change is in the MESSAGE-HISTORY rendering " +
    "(omp pruned/rewrote old tool results, e.g. after long idle or near the context limit) " +
    "or in TOOL SCHEMAS (omp version update). Those aren't diffable from here."
  );
}
