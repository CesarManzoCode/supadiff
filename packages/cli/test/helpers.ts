import { vi } from "vitest";

export interface CapturedOutput {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

/** Captures everything written to process.stdout/stderr during a test, without ANSI/color. */
export function captureStreams(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}
