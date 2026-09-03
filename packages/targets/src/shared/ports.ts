import { createServer } from "node:net";

/**
 * Leases one ephemeral local port by binding `0` and immediately releasing it
 * (§4.3: "Ports are allocated by binding port `0`... Hard-coded ports are forbidden").
 * There is an inherent, small TOCTOU window between release and the caller's own
 * bind; callers that need atomicity should retry bind-and-serve on `EADDRINUSE`.
 */
export function leasePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        reject(new Error("leasePort: could not determine bound port"));
        return;
      }
      const { port } = address;
      srv.close(() => resolve(port));
    });
  });
}
