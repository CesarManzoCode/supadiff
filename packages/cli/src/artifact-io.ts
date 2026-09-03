import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Writes a bundle (§9.1) as a deterministic directory tree — the contract's alternate
 * accepted artifact format alongside a ZIP. Entries are written in sorted path order;
 * file bytes are exactly the canonical bytes computed by `buildBundle`, so two runs of
 * the same plan produce byte-identical files on disk.
 */
export async function writeBundleDirectory(
  files: Map<string, Buffer>,
  outDir: string,
): Promise<void> {
  for (const [relPath] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (relPath.includes("..") || path.isAbsolute(relPath)) {
      throw new Error(`artifact-io: refusing unsafe bundle path "${relPath}"`);
    }
  }
  await mkdir(outDir, { recursive: true });
  for (const [relPath, buf] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const abs = path.join(outDir, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buf);
  }
}

/** Reads a previously written bundle directory back into the same path -> bytes map. */
export async function readBundleDirectory(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(sub: string): Promise<void> {
    const entries = await readdir(path.join(dir, sub), { withFileTypes: true });
    for (const entry of entries) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else files.set(rel, await readFile(path.join(dir, rel)));
    }
  }
  await walk("");
  return files;
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
