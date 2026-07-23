import { vi } from "vitest";
import type { CliContext } from "../../src/cli/context.js";

export interface CapturedCli {
  context: CliContext;
  stdout: string[];
  stderr: string[];
}

export interface CapturedCliOptions {
  stdin?: string;
}

export function createCapturedCli(
  overrides: Partial<CliContext> = {},
  options: CapturedCliOptions = {},
): CapturedCli {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const context: CliContext = {
    cwd: process.cwd(),
    env: {},
    homeDir: process.cwd(),
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    fetchImpl: vi.fn<typeof fetch>(),
    readStdin: () => Promise.resolve(options.stdin ?? ""),
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
    ...overrides,
  };
  return { context, stdout, stderr };
}

export function createCliTestContext(
  options: CapturedCliOptions = {},
): CapturedCli {
  return createCapturedCli({}, options);
}
