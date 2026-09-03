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

/**
 * Reads a `ResourceDeclaration`'s bytes as raw binary — the convention for Storage
 * fixture resources (§3.2) is base64 in `source.value` for inline resources, so a byte
 * payload survives canonical-JSON round-tripping the same way a SQL text resource does.
 */
export async function readResourceBytes(source: JsonObject): Promise<Uint8Array> {
  const kind = source["kind"] as "inline" | "content";
  if (kind === "inline") return Buffer.from(source["value"] as string, "base64");
  const root = process.env["SUPADIFF_RESOURCE_ROOT"] ?? process.cwd();
  const { default: path } = await import("node:path");
  return readFile(path.join(root, source["path"] as string));
}
