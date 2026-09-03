import { describe, expect, it } from "vitest";
import { writeBundleDirectory } from "../src/artifact-io.js";
import { freshOutDir } from "./fixtures.js";

describe("writeBundleDirectory: malicious path rejection", () => {
  it("refuses a path traversal entry (../)", async () => {
    const out = await freshOutDir();
    const files = new Map([["../escape.json", Buffer.from("{}")]]);
    await expect(writeBundleDirectory(files, out)).rejects.toThrow(/unsafe bundle path/);
  });

  it("refuses an absolute path entry", async () => {
    const out = await freshOutDir();
    const files = new Map([["/etc/passwd", Buffer.from("x")]]);
    await expect(writeBundleDirectory(files, out)).rejects.toThrow(/unsafe bundle path/);
  });

  it("refuses a nested traversal entry (a/../../escape.json)", async () => {
    const out = await freshOutDir();
    const files = new Map([["a/../../escape.json", Buffer.from("x")]]);
    await expect(writeBundleDirectory(files, out)).rejects.toThrow(/unsafe bundle path/);
  });

  it("writes legitimate nested paths successfully", async () => {
    const out = await freshOutDir();
    const files = new Map([
      ["manifest.json", Buffer.from("{}")],
      ["runs/reference/raw/step__1__x.json", Buffer.from("{}")],
    ]);
    await expect(writeBundleDirectory(files, out)).resolves.toBeUndefined();
  });
});
