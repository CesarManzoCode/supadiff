import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * A fresh, isolated local workdir per §4.3: "Every local run receives a new workdir
 * under a caller-selected or OS temporary root." Never reused across provisions and
 * never the same directory a running project already occupies.
 */
export interface Workdir {
  readonly path: string;
  cleanup(): void;
}

const ROOT_ENV = "SUPADIFF_LOCAL_WORKDIR_ROOT";

export function createWorkdir(namePrefix: string): Workdir {
  const root = process.env[ROOT_ENV] ?? tmpdir();
  const dir = mkdtempSync(path.join(root, `${namePrefix}-`));
  return {
    path: dir,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}
