import { readFile } from "node:fs/promises";
import type { JsonObject } from "@supadiff/spec";

/**
 * Reads a `ResourceDeclaration`'s bytes as UTF-8 text (§3.2: SQL/fixtures are data, not
 * executable scripts). `content`-kind resources resolve relative to
 * `SUPADIFF_RESOURCE_ROOT` (defaulted to the process cwd), never an absolute or
 * symlink-escaping path — scenario resource paths are validated upstream by
 * `@supadiff/spec` before a driver ever sees them.
 */
export async function readResourceText(source: JsonObject): Promise<string> {
  const kind = source["kind"] as "inline" | "content";
  if (kind === "inline") return source["value"] as string;
  const root = process.env["SUPADIFF_RESOURCE_ROOT"] ?? process.cwd();
  const { default: path } = await import("node:path");
  return readFile(path.join(root, source["path"] as string), "utf8");
}
