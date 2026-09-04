import { HostedRateLimitError, ManagementApiError } from "./errors.js";

/**
 * Every management- and data-plane request a hosted target issues in one run is counted
 * against `config.maxRequests`. Hitting the cap aborts rather than continuing to spend
 * against a real hosted project (§ hosted rate/cost limits).
 */
export class RequestBudget {
  #count = 0;
  readonly #max: number;
  constructor(max: number) {
    this.#max = max;
  }
  get used(): number {
    return this.#count;
  }
  get max(): number {
    return this.#max;
  }
  spend(n = 1): void {
    this.#count += n;
    if (this.#count > this.#max) throw new HostedRateLimitError(this.#max);
  }
}

export interface HostedProjectInfo {
  ref: string;
  name: string;
  region: string;
  status: string;
  /** e.g. `15.8.1.093`. */
  databaseVersion: string;
}

export interface HostedApiKeys {
  anonKey: string;
  serviceRoleKey: string;
}

export interface QueryResult {
  rows: Array<Record<string, unknown>>;
}

/**
 * The slice of the Supabase Management API (`https://api.supabase.com/v1`) the L13 driver
 * needs. An interface, not a concrete class, so the safety/fault tests can substitute a
 * double that injects management-plane faults (5xx, timeout, malformed body) without ever
 * touching the network.
 */
export interface ManagementClient {
  getProject(ref: string): Promise<HostedProjectInfo>;
  getApiKeys(ref: string): Promise<HostedApiKeys>;
  /** Runs SQL through `POST /v1/projects/{ref}/database/query` (postgres role). */
  runQuery(ref: string, sql: string): Promise<QueryResult>;
  createProject(input: {
    name: string;
    organizationId: string;
    region: string;
    dbPass: string;
    plan: "free" | "pro";
  }): Promise<HostedProjectInfo>;
  deleteProject(ref: string): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Real HTTP implementation over the Supabase Management API. */
export class HttpManagementClient implements ManagementClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #budget: RequestBudget;
  readonly #timeoutMs: number;

  constructor(opts: {
    baseUrl: string;
    accessToken: string;
    budget: RequestBudget;
    timeoutMs?: number;
  }) {
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.#token = opts.accessToken;
    this.#budget = opts.budget;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.#budget.spend();
    const endpoint = `${method} ${path}`;
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "User-Agent": "supadiff/1.0 (+L13 hosted target)",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new ManagementApiError(endpoint, 0, `unreachable: ${String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      // Trim the body so a management error can never smuggle an echoed token into a message.
      throw new ManagementApiError(endpoint, res.status, text.slice(0, 200));
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ManagementApiError(endpoint, res.status, "response body was not valid JSON");
    }
  }

  async getProject(ref: string): Promise<HostedProjectInfo> {
    const raw = await this.#request<{
      id: string;
      name: string;
      region: string;
      status: string;
      database?: { version?: string };
    }>("GET", `/v1/projects/${ref}`);
    return {
      ref: raw.id,
      name: raw.name,
      region: raw.region,
      status: raw.status,
      databaseVersion: raw.database?.version ?? "unknown",
    };
  }

  async getApiKeys(ref: string): Promise<HostedApiKeys> {
    const raw = await this.#request<Array<{ name: string; api_key: string }>>(
      "GET",
      `/v1/projects/${ref}/api-keys?reveal=true`,
    );
    const find = (n: string): string => raw.find((k) => k.name === n)?.api_key ?? "";
    const anonKey = find("anon");
    const serviceRoleKey = find("service_role");
    if (!anonKey || !serviceRoleKey) {
      throw new ManagementApiError(
        `GET /v1/projects/${ref}/api-keys`,
        200,
        "response did not include both an anon and a service_role key",
      );
    }
    return { anonKey, serviceRoleKey };
  }

  async runQuery(ref: string, sql: string): Promise<QueryResult> {
    const raw = await this.#request<unknown>("POST", `/v1/projects/${ref}/database/query`, {
      query: sql,
    });
    const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    return { rows };
  }

  async createProject(input: {
    name: string;
    organizationId: string;
    region: string;
    dbPass: string;
    plan: "free" | "pro";
  }): Promise<HostedProjectInfo> {
    const raw = await this.#request<{
      id: string;
      name: string;
      region: string;
      status: string;
      database?: { version?: string };
    }>("POST", `/v1/projects`, {
      name: input.name,
      organization_id: input.organizationId,
      region: input.region,
      db_pass: input.dbPass,
      plan: input.plan,
    });
    return {
      ref: raw.id,
      name: raw.name,
      region: raw.region,
      status: raw.status,
      databaseVersion: raw.database?.version ?? "unknown",
    };
  }

  async deleteProject(ref: string): Promise<void> {
    await this.#request<unknown>("DELETE", `/v1/projects/${ref}`);
  }
}
