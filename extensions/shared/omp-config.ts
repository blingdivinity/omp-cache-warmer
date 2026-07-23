import { createHash } from "node:crypto";

/**
 * Read-only peek at omp's own global config (~/.omp/agent/config.yml) for the
 * bits that change cache behavior. Naive line-matching instead of a YAML
 * parser: the keys are unique to the compaction block in practice, and a false
 * negative just means we keep the (safe) flush-assuming behavior.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * True when the user disabled omp's supersede pass (`compaction.supersedeReads`
 * AND `compaction.dropUseless` both false). The 90m idle flush only runs inside
 * that pass, so with both off a long-idle live process never rewrites its sent
 * history — idle-flush warnings and ping cutoffs become obsolete.
 */
export function ompIdleFlushDisabled(): boolean {
  for (const name of ["config.yml", "config.yaml"]) {
    try {
      const text = readFileSync(join(homedir(), ".omp", "agent", name), "utf8");
      return /^\s*supersedeReads:\s*false\b/m.test(text) && /^\s*dropUseless:\s*false\b/m.test(text);
    } catch {}
  }
  return false;
}

/**
 * Fingerprint the un-pinnable prefix component: the active tool schemas plus
 * the omp version that renders them. Tool schemas precede the system prompt in
 * the request, so any change to the tool set or its rendering invalidates the
 * whole cached prefix — something prefix-pin.ts cannot freeze. We hash the tool
 * NAMES (order preserved: the render order is part of the prefix bytes) and a
 * best-effort omp version into a short sha256 hex.
 *
 * Returns undefined when tools are unavailable (older omp whose event-handler
 * ctx does not expose getActiveTools) — every downstream check then skips, so
 * behavior degrades to exactly today's.
 */
export function toolsFingerprint(ctx: unknown): string | undefined {
  const c = ctx as { getActiveTools?: () => string[] };
  if (typeof c.getActiveTools !== "function") return undefined;
  let names: string[];
  try {
    names = c.getActiveTools();
  } catch {
    return undefined;
  }
  if (!Array.isArray(names)) return undefined;
  // Best-effort version: the event-handler ctx exposes no version field, so
  // fall back to the env omp sets for its own subprocesses, else null. The
  // tool-name list alone is still valuable — a null version just means we miss
  // pure-version bumps that leave the tool set identical (rare).
  const ompVersion = process.env.OMP_VERSION ?? process.env.PI_VERSION ?? null;
  const payload = JSON.stringify({ tools: names, ompVersion });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}
