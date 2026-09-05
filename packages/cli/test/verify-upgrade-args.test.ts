import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/index.js";

describe("supadiff verify-upgrade: --supalite-version parsing", () => {
  it("defaults to no supaliteVersion (the historical 0.9.0 baseline)", () => {
    const args = parseArgs(["verify-upgrade"]);
    expect(args.upgrade?.supaliteVersion).toBeUndefined();
    expect(args.upgrade?.execute).toBe(false);
  });

  it("parses --supalite-version alongside --execute", () => {
    const args = parseArgs(["verify-upgrade", "--supalite-version", "0.10.0", "--execute"]);
    expect(args.upgrade?.supaliteVersion).toBe("0.10.0");
    expect(args.upgrade?.execute).toBe(true);
  });
});
