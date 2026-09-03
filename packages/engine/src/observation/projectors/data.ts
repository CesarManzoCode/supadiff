import type { RawObservation, SemanticObservation } from "@supadiff/spec";
import { computeCoverage } from "../coverage.js";
import { jsonPointerGet } from "../../values/json-pointer.js";
import type { Projector } from "./types.js";

function projectRowCollectionOperation(projectorId: string, ordered: boolean): Projector {
  return (raw: RawObservation): SemanticObservation => {
    const body = raw.transport.responseBody;
    const status = jsonPointerGet(body, "/status");
    const rows = jsonPointerGet(body, "/rows");

    const contractual = ["/status", "/rows"];
    const ignored = [
      {
        selector: "/count",
        reason: "row count is diagnostic unless the scenario explicitly requests it",
        rule: { id: "diagnostic.row-count", version: "1" },
        evidence: ["Architecture Contract §6.1"],
      },
    ];
    const coverage = computeCoverage(body, { contractual, diagnostic: [], ignored: ["/count"] });

    return {
      format: "supadiff.semantic-observation",
      projector: { id: projectorId, version: "1" },
      sourceRawDigest: `sha256:${"0".repeat(64)}`,
      service: "data",
      operation: raw.operation,
      contractFields: { "/status": (status ?? null) as never, "/rows": (rows ?? null) as never },
      ignoredFields: ignored,
      relationships: [],
      stateFacts: [{ label: "ordered", value: ordered }],
      coverage,
    };
  };
}

export const dataSelectProjector = projectRowCollectionOperation("data.select", true);
export const dataInsertProjector = projectRowCollectionOperation("data.insert", false);
export const observeDataReadbackProjector = projectRowCollectionOperation(
  "observe.dataReadback",
  true,
);
