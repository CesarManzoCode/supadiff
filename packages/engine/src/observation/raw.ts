import type {
  IsoDateTime,
  JsonValue,
  RawObservation,
  RawOutcomeCategory,
  StableId,
} from "@supadiff/spec";
import type { ActorBinding, RawOperationResult, SecretVault } from "../spi/types.js";
import { redactTransport } from "./redact.js";

export interface BuildRawObservationInput {
  observationId: StableId;
  origin: RawObservation["origin"];
  runId: StableId;
  targetSlot: StableId;
  stepId: StableId;
  attempt: number;
  operation: { id: StableId; version: string };
  actor: ActorBinding | undefined;
  startedAt: IsoDateTime;
  requestBody: JsonValue | undefined;
  result: RawOperationResult;
  vault: SecretVault;
  configuredLiterals: string[];
}

export interface RawObservationBuildResult {
  observation: RawObservation;
  redactionFailed: boolean;
}

function outcomeCategoryOf(result: RawOperationResult): RawOutcomeCategory {
  if (result.category === "harness-failure") return "harness-failure";
  if (result.status !== undefined && result.status >= 400) return "application-error";
  return "success";
}

export function buildRawObservation(input: BuildRawObservationInput): RawObservationBuildResult {
  const operationRefId = `${input.operation.id}@${input.operation.version}`;
  const redaction = redactTransport({
    operationRefId,
    requestBody: input.requestBody,
    requestHeaders: input.result.requestHeaders,
    responseBody: input.result.responseBody,
    responseHeaders: input.result.responseHeaders,
    vault: input.vault,
    configuredLiterals: input.configuredLiterals,
  });

  const observation: RawObservation = {
    format: "supadiff.raw-observation",
    observer: { id: "engine.execute", version: "1" },
    observationId: input.observationId,
    origin: input.origin,
    runId: input.runId,
    targetSlot: input.targetSlot,
    stepId: input.stepId,
    attempt: input.attempt,
    operation: input.operation,
    actor: { actorId: input.actor?.actorId, role: input.actor?.role ?? "anon" },
    startedAt: input.startedAt,
    durationMs: input.result.durationMs,
    transport: { ...redaction.transport, status: input.result.status },
    outcome: { category: outcomeCategoryOf(input.result) },
    attachments: [],
    redaction: redaction.receipt,
  };

  return { observation, redactionFailed: redaction.redactionFailed };
}
