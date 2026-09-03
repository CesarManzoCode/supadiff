import { spawn, type ChildProcess } from "node:child_process";

export interface ManagedProcess {
  readonly pid: number;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves once the process has actually exited (SIGTERM, then SIGKILL after a grace period). */
  kill(): Promise<void>;
  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const MAX_BUFFERED_BYTES = 256 * 1024;

function boundedAppend(buf: { text: string }, chunk: Buffer): void {
  buf.text += chunk.toString("utf8");
  if (buf.text.length > MAX_BUFFERED_BYTES) {
    buf.text = buf.text.slice(buf.text.length - MAX_BUFFERED_BYTES);
  }
}

/**
 * Spawns a subprocess in its own process group (`detached: true` on POSIX) so
 * teardown can terminate the whole tree it may have started, never a bare `kill -9`
 * on unrelated host processes (§4.6, §19 R-025 — only journaled owned resources).
 */
export function spawnManaged(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): ManagedProcess {
  const child: ChildProcess = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (child.pid === undefined) {
    throw new Error(`spawnManaged: failed to start "${command} ${args.join(" ")}"`);
  }

  const outBuf = { text: "" };
  const errBuf = { text: "" };
  child.stdout?.on("data", (c: Buffer) => boundedAppend(outBuf, c));
  child.stderr?.on("data", (c: Buffer) => boundedAppend(errBuf, c));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let settled = false;
    const done = (v: { code: number | null; signal: NodeJS.Signals | null }): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.on("exit", (code, signal) => done({ code, signal }));
    // A spawn that fails asynchronously (ENOENT, EACCES, …) emits 'error' and never 'exit';
    // without this listener that becomes an unhandled exception that can crash the process.
    // Surface it through the same exit promise as a non-zero code instead.
    child.on("error", (err) => {
      boundedAppend(errBuf, Buffer.from(`spawn error: ${String(err)}`));
      done({ code: -1, signal: null });
    });
  });

  async function kill(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid !== undefined) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      /* already dead */
    }
    const graceMs = 3000;
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((r) => setTimeout(() => r(true), graceMs)),
    ]);
    if (timedOut) {
      try {
        if (process.platform !== "win32" && child.pid !== undefined) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* already dead */
      }
      await exited;
    }
  }

  return {
    pid: child.pid,
    stdout: () => outBuf.text,
    stderr: () => errBuf.text,
    kill,
    waitForExit: () => exited,
    exited,
  };
}

/** Polls `url` until it returns any HTTP response (not necessarily 2xx) or `timeoutMs` elapses. */
export async function waitForHttpReady(
  url: string,
  opts: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal },
): Promise<void> {
  const interval = opts.intervalMs ?? 100;
  const deadline = Date.now() + opts.timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error("waitForHttpReady: aborted");
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(interval * 5, 2000)) });
      void res.status;
      return;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
  throw new Error(
    `waitForHttpReady: "${url}" did not become ready within ${opts.timeoutMs}ms: ${String(lastError)}`,
  );
}
