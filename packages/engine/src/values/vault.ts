import { createHash, createHmac, randomBytes } from "node:crypto";
import type { SecretHandle, SecretVault } from "../spi/types.js";

/**
 * In-memory `SecretVault` (§2.6, §4.5). Secret bytes never leave this module except
 * through `reveal`, which only driver dispatch code should call. Runtime-only:
 * never serialized into a plan, trace, or artifact.
 *
 * Handle IDs are opaque identifiers, not secrets: opacity here means "not derivable
 * from the secret value", not "cryptographically unpredictable". Passing a `seed`
 * (the run's scenario seed + target slot) makes handle generation deterministic, so
 * two executions of the same plan produce byte-identical artifacts (§9.1); omitting
 * it falls back to random handles for ad-hoc/test use.
 */
export class InMemorySecretVault implements SecretVault {
  #store = new Map<SecretHandle, { value: string; secretClass: string }>();
  #fingerprintKey = randomBytes(32);
  #destroyed = false;
  #seed: string | undefined;
  #counter = 0;

  constructor(seed?: string) {
    this.#seed = seed;
  }

  #nextHandle(): SecretHandle {
    if (this.#seed === undefined) return `sec-${randomBytes(12).toString("hex")}`;
    const hex = createHash("sha256")
      .update(`${this.#seed}:${this.#counter++}`)
      .digest("hex")
      .slice(0, 24);
    return `sec-${hex}`;
  }

  put(secretClass: string, value: string): SecretHandle {
    if (this.#destroyed) throw new Error("SecretVault: put() after destroy()");
    const handle = this.#nextHandle();
    this.#store.set(handle, { value, secretClass });
    return handle;
  }

  reveal(handle: SecretHandle): string {
    if (this.#destroyed) throw new Error("SecretVault: reveal() after destroy()");
    const entry = this.#store.get(handle);
    if (!entry) throw new Error(`SecretVault: unknown handle "${handle}"`);
    return entry.value;
  }

  fingerprint(handle: SecretHandle): string {
    const entry = this.#store.get(handle);
    if (!entry) throw new Error(`SecretVault: unknown handle "${handle}"`);
    return createHmac("sha256", this.#fingerprintKey)
      .update(entry.value)
      .digest("hex")
      .slice(0, 16);
  }

  has(handle: SecretHandle): boolean {
    return this.#store.has(handle);
  }

  /** Destroys the fingerprint key and all secret values. Irreversible (§2.6). */
  destroy(): void {
    this.#store.clear();
    this.#fingerprintKey.fill(0);
    this.#destroyed = true;
  }
}
