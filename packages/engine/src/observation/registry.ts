import {
  sha256OfCanonicalJson,
  type JsonValue,
  type RawObservation,
  type SemanticObservation,
} from "@supadiff/spec";
import {
  authRefreshSessionProjector,
  authSignInWithPasswordProjector,
  authSignUpProjector,
} from "./projectors/auth.js";
import {
  dataInsertProjector,
  dataSelectProjector,
  observeDataReadbackProjector,
} from "./projectors/data.js";
import {
  storageCreateSignedUrlProjector,
  storageRedeemUrlProjector,
  observeStorageObjectProjector,
  storageCreateBucketProjector,
  storageUploadProjector,
  storageDownloadProjector,
  storageListProjector,
  storageRemoveProjector,
  storageMoveProjector,
  storageCopyProjector,
} from "./projectors/storage.js";
import {
  assertInvariantProjector,
  cliInvokeProjector,
  observeAuthSessionProjector,
} from "./projectors/cli-and-observers.js";
import type { Projector } from "./projectors/types.js";

/** Registered semantic projectors (§6.3). Only operations with a fake-target fixture are wired. */
const PROJECTORS: Record<string, Projector> = {
  "auth.signUp@1": authSignUpProjector,
  "auth.signInWithPassword@1": authSignInWithPasswordProjector,
  "auth.refreshSession@1": authRefreshSessionProjector,
  "data.select@1": dataSelectProjector,
  "data.insert@1": dataInsertProjector,
  "observe.dataReadback@1": observeDataReadbackProjector,
  "storage.createSignedUrl@1": storageCreateSignedUrlProjector,
  "storage.redeemUrl@1": storageRedeemUrlProjector,
  "observe.storageObject@1": observeStorageObjectProjector,
  "storage.createBucket@1": storageCreateBucketProjector,
  "storage.upload@1": storageUploadProjector,
  "storage.download@1": storageDownloadProjector,
  "storage.list@1": storageListProjector,
  "storage.remove@1": storageRemoveProjector,
  "storage.move@1": storageMoveProjector,
  "storage.copy@1": storageCopyProjector,
  "cli.invoke@1": cliInvokeProjector,
  "observe.authSession@1": observeAuthSessionProjector,
  "assert.invariant@1": assertInvariantProjector,
};

export function hasProjector(operationId: string, version: string): boolean {
  return `${operationId}@${version}` in PROJECTORS;
}

/**
 * Projects a raw observation into its semantic observation using the registered pure
 * projector, then stamps the real digest of the raw observation it was derived from.
 */
export function project(raw: RawObservation): SemanticObservation {
  const projector = PROJECTORS[`${raw.operation.id}@${raw.operation.version}`];
  if (!projector) {
    throw new Error(
      `no semantic projector registered for "${raw.operation.id}@${raw.operation.version}"`,
    );
  }
  const semantic = projector(raw);
  const sourceRawDigest = sha256OfCanonicalJson(raw as unknown as JsonValue);
  return { ...semantic, sourceRawDigest };
}
