import { describe, expect, it } from "vitest";
import { computeCoverage } from "../../src/index.js";

describe("computeCoverage: recursive field coverage over the full JSON tree (§6.1, §7.3)", () => {
  it("flags a nested unassessed field the projector never declared (/user/id, /user/role declared, /user/new_field not)", () => {
    const body = { user: { id: "u1", role: "owner", new_field: "surprise" } };
    const coverage = computeCoverage(body, {
      contractual: ["/user/id", "/user/role"],
      diagnostic: [],
      ignored: [],
    });
    expect(coverage.unassessedFields).toEqual(["/user/new_field"]);
  });

  it("walks nested arrays and flags an unassessed field inside an array item", () => {
    const body = { items: [{ id: 1, extra: "x" }] };
    const coverage = computeCoverage(body, {
      contractual: ["/items/0/id"],
      diagnostic: [],
      ignored: [],
    });
    expect(coverage.unassessedFields).toEqual(["/items/0/extra"]);
  });

  it("escapes '~' and '/' in field names per RFC 6901 (~0 / ~1)", () => {
    const body = { "a/b": { "c~d": "value" } };
    const coverageUncovered = computeCoverage(body, {
      contractual: [],
      diagnostic: [],
      ignored: [],
    });
    expect(coverageUncovered.unassessedFields).toEqual(["/a~1b/c~0d"]);

    const coverageCovered = computeCoverage(body, {
      contractual: ["/a~1b/c~0d"],
      diagnostic: [],
      ignored: [],
    });
    expect(coverageCovered.unassessedFields).toEqual([]);
  });

  it("a path declared as a contractual atomic subtree is never traversed — its children are not falsely unassessed", () => {
    const body = { session: { access_token: "t", refresh_token: "r", nested: { deeper: 1 } } };
    const coverage = computeCoverage(body, {
      contractual: ["/session"],
      diagnostic: [],
      ignored: [],
    });
    expect(coverage.unassessedFields).toEqual([]);
  });

  it("an ignored nested path is not unassessed, and its children are not traversed either", () => {
    const body = { meta: { count: 3, internal: { x: 1 } } };
    const coverage = computeCoverage(body, {
      contractual: [],
      diagnostic: [],
      ignored: ["/meta/count"],
    });
    // /meta/count is accounted for; /meta itself is a container (never flagged), but
    // /meta/internal was never declared at any depth, so recursion continues into it.
    expect(coverage.unassessedFields).toEqual(["/meta/internal/x"]);
  });

  it("a diagnostic nested path is accounted for and its subtree is not traversed", () => {
    const body = { debug: { trace: { spans: [1, 2, 3] } } };
    const coverage = computeCoverage(body, {
      contractual: [],
      diagnostic: ["/debug/trace"],
      ignored: [],
    });
    expect(coverage.unassessedFields).toEqual([]);
  });

  it("an unknown nested field produces exactly the unassessed entries, none extra, none missing", () => {
    const body = { a: { b: { c: 1, d: 2 } }, known: "ok" };
    const coverage = computeCoverage(body, {
      contractual: ["/known"],
      diagnostic: [],
      ignored: [],
    });
    expect(coverage.unassessedFields.sort()).toEqual(["/a/b/c", "/a/b/d"]);
  });

  it("an empty nested object/array that is not declared is itself unassessed (nothing to descend into)", () => {
    const body = { emptyObj: {}, emptyArr: [] };
    const coverage = computeCoverage(body, { contractual: [], diagnostic: [], ignored: [] });
    expect(coverage.unassessedFields.sort()).toEqual(["/emptyArr", "/emptyObj"]);
  });

  it("a top-level array response body is walked recursively too", () => {
    const body = [{ id: 1, leak: "x" }];
    const coverage = computeCoverage(body, { contractual: ["/0/id"], diagnostic: [], ignored: [] });
    expect(coverage.unassessedFields).toEqual(["/0/leak"]);
  });
});
