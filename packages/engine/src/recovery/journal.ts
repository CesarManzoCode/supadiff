import type { IsoDateTime } from "@supadiff/spec";
import type { RecoveryRecord, RecoveryResourceEntry } from "../spi/types.js";

/**
 * Append-only write-ahead recovery journal (§2.7, §4.2). Every entry MUST be written
 * before the corresponding external resource is actually allocated, even against a
 * fake provider, so a crash between "intent recorded" and "resource created" is always
 * detectable. Tombstones are appended after successful cleanup; a leaked resource is
 * one whose entry has no tombstone at teardown.
 */
export class RecoveryJournal {
  readonly runNamespace: string;
  #entries: RecoveryResourceEntry[] = [];

  constructor(runNamespace: string) {
    this.runNamespace = runNamespace;
  }

  recordIntent(
    resourceType: string,
    nonSecretIdentifier: string,
    creationIntent: string,
    cleanupAction: string,
    now: () => IsoDateTime,
  ): void {
    this.#entries.push({
      resourceType,
      nonSecretIdentifier,
      creationIntent,
      cleanupAction,
      createdAt: now(),
    });
  }

  tombstone(nonSecretIdentifier: string, now: () => IsoDateTime): void {
    const entry = [...this.#entries]
      .reverse()
      .find((e) => e.nonSecretIdentifier === nonSecretIdentifier && !e.tombstonedAt);
    if (entry) entry.tombstonedAt = now();
  }

  leakedEntries(): RecoveryResourceEntry[] {
    return this.#entries.filter((e) => !e.tombstonedAt);
  }

  toRecord(): RecoveryRecord {
    return { runNamespace: this.runNamespace, entries: [...this.#entries] };
  }
}
