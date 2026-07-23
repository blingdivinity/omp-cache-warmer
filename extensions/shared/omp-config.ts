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
