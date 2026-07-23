# Run Protocol Deep Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the 2026-07-23 deep-refactor design: structured agent-facing errors, typed run events, a single-lock/single-read RunSession, append-only journal writes, crash-safe evidence repair, and cleanup, released as 0.2.0.

**Architecture:** Milestone 1 rebuilds the error envelope, stdin parsing, and lock handling without touching protocol logic. Milestone 2 extracts a dependency-free ID module and turns `runEventSchema` into a discriminated union so one parse yields typed events. Milestone 3 introduces `RunSession` (one lock, one read, one validation per command), converts validators to single-pass accumulators, and makes single-event journal writes append-only while batches keep the atomic rewrite. Milestone 4 adds orphan-aware evidence parity with a manifest-driven `run repair` command, RunGroup staging creation, dead-code removal, single-run CI exit codes, and the version bump.

**Tech Stack:** TypeScript 5.9, Node.js 22/24, Commander 14, Zod 4, proper-lockfile 4, Vitest 4, pnpm 11.9.

**Spec:** `docs/superpowers/specs/2026-07-23-run-protocol-deep-refactor-design.md` — the binding contract. Where this plan and the spec disagree, the spec wins.

## Global Constraints

- On-disk formats for journals, configs, cases, evidence, and reports do not change; 0.1.0 project data must remain readable.
- CLI JSON output and error codes may break; the error envelope is `{ "error": { code, message, retryable?, details?, issues? } }` with `retryable` serialized only when `true`, and `details`/`issues` omitted when empty.
- Global lock order is journal first, evidence nested inside; never acquire in the other order.
- Lock compromise is never auto-retryable; `withLock` always awaits callback settlement.
- The torn-write condition is exactly: non-empty `events.jsonl` that does not end with `\n`.
- Multi-event journal batches never use line appends; they use the atomic full-file rewrite.
- Repair is the only code path that deletes or truncates; readers only classify and report.
- Every task ends with the quality gate for its scope green; the final task runs the complete `pnpm check`.
- Commit after every task with the message given in its final step.

---

## File structure

Milestone 1
- Modify `src/core/errors.ts`: `retryable`/`issues` on `AiQaError`; cause-preserving normalization.
- Modify `src/cli/program.ts`: one error serializer, drop the unknown-command remap, real `--version`.
- Modify `src/cli/io.ts`: split `input.invalid_json` from `input.schema_invalid`.
- Create `src/core/fs/locking.ts`: operation-scoped `withLock` with `hot`/`cold` profiles.
- Modify the nine `lockfile.lock` call sites (listed in Task 3) to use `withLock`.
- Modify `src/core/runs/journal.ts`, `src/services/run-protocol/run-protocol-service.ts`, `src/services/case-promotion/draft-case.ts`: stop swallowing causes.
- Create `tests/cli/error-output.test.ts`, `tests/unit/locking.test.ts`.

Milestone 2
- Create `src/core/runs/ids.ts`: ID schemas with zero project imports.
- Modify `src/core/runs/schema.ts`: re-export IDs; discriminated-union `runEventSchema`; distributive `AppendRunEvent`.
- Modify `src/core/runs/event-payloads.ts`, `src/core/runs/lifecycle.ts`, `src/core/verdicts/schema.ts`, `src/core/evidence/schema.ts`: import IDs from `ids.ts`; export `lifecyclePayloadSchema`.
- Create `tests/unit/run-event-schema.test.ts`.

Milestone 3
- Create `src/services/run-protocol/run-session.ts`: `RunSnapshot`, `withRunSession`, batch append.
- Modify `src/services/run-protocol/run-protocol-service.ts`, `regression-fidelity.ts`, `read-run-state.ts`, `run-lifecycle.ts`, `finalize-run.ts`, `verdict-service.ts`, `register-evidence.ts`: session-based, accumulator validation.
- Modify `src/cli/commands/protocol-helpers.ts`: print the in-lock result; stop re-reading.
- Modify `src/core/runs/journal.ts`: append-only single events, batch rewrite, torn-tail classification.
- Create `tests/unit/journal-append.test.ts`; modify `tests/integration/run-hardening.test.ts`.

Milestone 4
- Modify `src/core/evidence/parity.ts`, `src/services/run-protocol/register-evidence.ts`, `run-lifecycle.ts`: orphan classification, hot-path hash removal.
- Create `src/services/run-repair/repair-run.ts`, `src/cli/commands/repair.ts`; create `tests/integration/run-repair.test.ts`.
- Modify `src/core/run-groups/repository.ts`, `src/services/run-groups/start-run-group.ts`, `src/services/run-protocol/start-exploratory-run.ts`: staging + rename, stale-staging sweeps.
- Cleanup deletions and consolidations across `src/core` and `src/services` (enumerated in Task 12).
- Modify `src/cli/commands/report.ts`, `package.json`, `README.md`.

---

## Milestone 1: Error layer and lock consolidation

### Task 1: Error envelope, unknown-command fix, real version

**Files:**
- Modify: `src/core/errors.ts`
- Modify: `src/cli/program.ts`
- Create: `tests/cli/error-output.test.ts`

**Interfaces:**
- Consumes: existing `CliContext` from `src/cli/context.ts` and the capture-context helper in `tests/helpers/cli-context.ts`.
- Produces: `AiQaError` constructor `(code: string, message: string, details?: Readonly<Record<string, unknown>>, options?: { retryable?: boolean; issues?: readonly ErrorIssue[] })` with readonly `retryable: boolean` and `issues: readonly ErrorIssue[] | undefined`.
- Produces: `ErrorIssue = { path: readonly (string | number)[]; code: string; message: string }` exported from `src/core/errors.ts`.
- Produces: `writeErrorJson(context: CliContext, error: AiQaError): void` exported from `src/cli/program.ts` for Task 2's tests.

- [ ] **Step 1: Write failing tests for the envelope, unknown command, and version**

Create `tests/cli/error-output.test.ts`. Use the same capture-context pattern `tests/cli/help.test.ts` uses (a `CliContext` whose `writeStdout`/`writeStderr` collect into arrays, driven through `runCli` from `src/cli/program.ts`):

```ts
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/program.js";
import { createCliTestContext } from "../helpers/cli-context.js";

describe("error output contract", () => {
  it("reports unknown subcommands with commander's own message", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(["definitely-not-a-command"], context.context);
    expect(exitCode).toBe(1);
    const payload = JSON.parse(context.stderr.join("")) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe("commander.unknownCommand");
    expect(payload.error.message).toContain("definitely-not-a-command");
    expect(payload.error.message).not.toContain("too many arguments");
  });

  it("reports the real package version", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(["--version"], context.context);
    expect(exitCode).toBe(0);
    const { createRequire } = await import("node:module");
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      version: string;
    };
    expect(context.stdout.join("")).toContain(pkg.version);
  });

  it("emits issues for top-level option validation failures", async () => {
    const context = createCliTestContext();
    const exitCode = await runCli(
      ["run", "start", "--kind", "bogus", "--platform", "web", "--execution", "local", "--stdin-json"],
      context.context,
    );
    expect(exitCode).toBe(1);
    const payload = JSON.parse(context.stderr.join("")) as {
      error: { code: string; issues?: { path: unknown[]; message: string }[] };
    };
    expect(payload.error.code).toBe("schema.validation_failed");
    expect(payload.error.issues?.length).toBeGreaterThan(0);
  });

  it("serializes retryable only when true and omits empty details and issues", async () => {
    const { AiQaError } = await import("../../src/core/errors.js");
    const { writeErrorJson } = await import("../../src/cli/program.js");
    const context = createCliTestContext();
    writeErrorJson(
      context.context,
      new AiQaError("storage.lock_contended", "Lock is contended", {
        path: "/tmp/x",
      }, { retryable: true }),
    );
    writeErrorJson(context.context, new AiQaError("run.not_found", "Missing"));
    const [retryableLine, plainLine] = context.stderr;
    expect(JSON.parse(retryableLine!).error).toEqual({
      code: "storage.lock_contended",
      message: "Lock is contended",
      retryable: true,
      details: { path: "/tmp/x" },
    });
    expect(JSON.parse(plainLine!).error).toEqual({
      code: "run.not_found",
      message: "Missing",
    });
  });
});
```

If `tests/helpers/cli-context.ts` does not already export a capture helper named `createCliTestContext` returning `{ context, stdout, stderr }`, add it there (read the file first; reuse whatever equivalent exists rather than duplicating).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/cli/error-output.test.ts`
Expected: FAIL — unknown command message says "too many arguments", version prints `0.0.0`, `writeErrorJson` is not exported.

- [ ] **Step 3: Extend `AiQaError` and add the serializer**

In `src/core/errors.ts`:

```ts
export interface ErrorIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export class AiQaError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly issues: readonly ErrorIssue[] | undefined;

  constructor(
    code: string,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options: { retryable?: boolean; issues?: readonly ErrorIssue[] } = {},
  ) {
    super(message);
    this.name = "AiQaError";
    this.code = code;
    this.details = details;
    this.retryable = options.retryable === true;
    this.issues = options.issues;
  }
}
```

`normalizeUnknownError` is unchanged in this task.

In `src/cli/program.ts` add and export:

```ts
export function writeErrorJson(context: CliContext, error: AiQaError): void {
  context.writeStderr(
    `${JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryable ? { retryable: true } : {}),
        ...(Object.keys(error.details).length > 0
          ? { details: error.details }
          : {}),
        ...(error.issues !== undefined && error.issues.length > 0
          ? { issues: error.issues }
          : {}),
      },
    })}\n`,
  );
}
```

Rewrite the `runCli` catch block to use it:

- Delete the `commander.excessArguments` remap and the synthetic "too many arguments" message (`src/cli/program.ts:74-82`); the `CommanderError` branch emits `{ error: { code: error.code, message: error.message } }` unchanged for every non-help, non-version code.
- The `AiQaError` branch becomes `writeErrorJson(context, error); return 1;`.
- The `ZodError` branch becomes:

```ts
if (error instanceof ZodError) {
  writeErrorJson(
    context,
    new AiQaError("schema.validation_failed", "Schema validation failed", {}, {
      issues: error.issues.map((issue) => ({
        path: issue.path.filter(
          (part): part is string | number => typeof part !== "symbol",
        ),
        code: issue.code,
        message: issue.message,
      })),
    }),
  );
  return 1;
}
```

- The final normalized branch becomes `writeErrorJson(context, normalizeUnknownError(error)); return 1;`.

Replace `.version("0.0.0")` (`src/cli/program.ts:28`) with:

```ts
import { createRequire } from "node:module";
const packageVersion = (
  createRequire(import.meta.url)("../../package.json") as { version: string }
).version;
// then in createProgram:
    .version(packageVersion)
```

`src/cli/program.ts` compiles to `dist/cli/program.js`, so `../../package.json` resolves to the package root in both trees.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/cli/error-output.test.ts tests/cli/help.test.ts`
Expected: PASS (help tests confirm no commander regression).

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add src/core/errors.ts src/cli/program.ts tests/cli/error-output.test.ts tests/helpers/cli-context.ts
git commit -m "feat: structured error envelope, real version, honest unknown-command errors"
```

### Task 2: Split stdin JSON failures

**Files:**
- Modify: `src/cli/io.ts`
- Modify: `tests/cli/error-output.test.ts`

**Interfaces:**
- Consumes: `AiQaError`, `ErrorIssue` from Task 1.
- Produces: `readJsonInput` unchanged in signature; failure codes `input.invalid_json` (malformed JSON) and `input.schema_invalid` (schema mismatch, with `issues`).

- [ ] **Step 1: Write failing tests**

Append to `tests/cli/error-output.test.ts`:

```ts
import { z } from "zod";
import { readJsonInput } from "../../src/cli/io.js";
import { AiQaError } from "../../src/core/errors.js";

describe("readJsonInput", () => {
  const schema = z.object({ goal: z.string().min(1) }).strict();

  it("reports malformed JSON as input.invalid_json", async () => {
    const context = createCliTestContext({ stdin: "{not json" });
    const error = await readJsonInput(context.context, schema).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("input.invalid_json");
    expect((error as AiQaError).issues).toBeUndefined();
  });

  it("reports schema mismatches as input.schema_invalid with issues", async () => {
    const context = createCliTestContext({ stdin: '{"goal":""}' });
    const error = await readJsonInput(context.context, schema).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("input.schema_invalid");
    expect((error as AiQaError).issues).toEqual([
      expect.objectContaining({ path: ["goal"] }),
    ]);
  });
});
```

Extend `createCliTestContext` to accept `{ stdin?: string }` and back `context.readStdin` with it if it does not already.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/cli/error-output.test.ts`
Expected: FAIL — both cases currently produce `input.invalid_json` without issues.

- [ ] **Step 3: Implement the split**

Replace the body of `readJsonInput` in `src/cli/io.ts`:

```ts
export async function readJsonInput<T>(
  context: CliContext,
  schema: z.ZodType<T>,
): Promise<T> {
  const source = await context.readStdin();
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error: unknown) {
    throw new AiQaError("input.invalid_json", "stdin must contain valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AiQaError(
      "input.schema_invalid",
      "stdin JSON does not match the expected schema",
      {},
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.filter(
            (part): part is string | number => typeof part !== "symbol",
          ),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}
```

- [ ] **Step 4: Run the full integration suites that exercise stdin errors**

Run: `pnpm vitest run tests/cli tests/integration/config-cli.test.ts tests/integration/typed-protocol.test.ts`
Expected: PASS after updating any assertion that pinned the old `input.invalid_json`-for-schema-errors behavior (update expected codes to `input.schema_invalid` where the fixture JSON was well-formed but schema-invalid).

- [ ] **Step 5: Commit**

```bash
git add src/cli/io.ts tests
git commit -m "feat: distinguish malformed stdin JSON from schema mismatches"
```

### Task 3: Operation-scoped locking

**Files:**
- Create: `src/core/fs/locking.ts`
- Create: `tests/unit/locking.test.ts`
- Modify: `src/core/fs/atomic-write.ts`, `src/core/fs/json-lines.ts` (pre-commit guard option)
- Modify (all nine `lockfile.lock` sites): `src/core/runs/journal.ts:152`, `src/core/runs/repository.ts:115`, `src/core/evidence/repository.ts:151`, `src/core/run-groups/repository.ts:108`, `src/core/run-groups/repository.ts:135`, `src/core/run-groups/repository.ts:223`, `src/core/cases/repository.ts:507`, `src/core/cases/repository.ts:513`, `src/core/reports/storage.ts:166`

**Interfaces:**
- Produces (from `src/core/fs/locking.ts`):

```ts
export type LockProfile = "hot" | "cold";
export interface LockSignal {
  compromised(): boolean;
}
export async function withLock<T>(
  path: string,
  profile: LockProfile,
  callback: (signal: LockSignal) => Promise<T>,
): Promise<T>;
```

- Semantics (binding, from the spec): `hot` retries 10 times from 50 ms with exponential backoff capped at 1 s; `cold` keeps today's 20-retry envelope (`retries: 20, minTimeout: 25, maxTimeout: 250` — read `src/core/runs/repository.ts:115-118` and copy its exact options). `ELOCKED` → `AiQaError("storage.lock_contended", ..., { path }, { retryable: true })`. On compromise: the signal flips, `withLock` awaits callback settlement, then throws `AiQaError("storage.lock_compromised", ...)` with no retryable flag regardless of whether the callback resolved or rejected. Lock release errors after compromise are swallowed.

- [ ] **Step 1: Write failing unit tests**

Create `tests/unit/locking.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiQaError } from "../../src/core/errors.js";
import { withLock } from "../../src/core/fs/locking.js";

describe("withLock", () => {
  let dir: string;
  let target: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ai-qa-lock-"));
    target = join(dir, "target.json");
    await writeFile(target, "{}\n", "utf8");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the callback and returns its result", async () => {
    await expect(withLock(target, "cold", () => Promise.resolve(7))).resolves.toBe(7);
  });

  it("maps exhausted contention to retryable storage.lock_contended", async () => {
    const release = await lockfile.lock(target, { realpath: false });
    try {
      const error = await withLock(target, "cold", () => Promise.resolve(1)).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(AiQaError);
      expect((error as AiQaError).code).toBe("storage.lock_contended");
      expect((error as AiQaError).retryable).toBe(true);
    } finally {
      await release();
    }
  }, 30_000);

  it("reports compromise as non-retryable after the callback settles", async () => {
    const order: string[] = [];
    const error = await withLock(target, "hot", async (signal) => {
      await rm(`${target}.lock`, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      order.push(signal.compromised() ? "saw-compromise" : "missed");
      order.push("settled");
      return 1;
    }).catch((thrown: unknown) => thrown);
    expect(order).toEqual(["saw-compromise", "settled"]);
    expect(error).toBeInstanceOf(AiQaError);
    expect((error as AiQaError).code).toBe("storage.lock_compromised");
    expect((error as AiQaError).retryable).toBe(false);
  }, 30_000);
});
```

For the compromise test, `withLock` must pass `stale`/`update` options that make proper-lockfile notice the deleted lockfile within ~2 s (`stale: 2000` yields `update: 1000`). Make those values the `hot` profile's defaults or accept them internally; do not add a test-only export.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/locking.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `withLock`**

Create `src/core/fs/locking.ts`:

```ts
import lockfile from "proper-lockfile";
import { AiQaError } from "../errors.js";

export type LockProfile = "hot" | "cold";

export interface LockSignal {
  compromised(): boolean;
}

const PROFILES = {
  hot: {
    retries: { retries: 10, minTimeout: 50, maxTimeout: 1_000 },
    stale: 2_000,
  },
  cold: {
    retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
  },
} as const;

export async function withLock<T>(
  path: string,
  profile: LockProfile,
  callback: (signal: LockSignal) => Promise<T>,
): Promise<T> {
  let compromised = false;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, {
      realpath: false,
      ...PROFILES[profile],
      onCompromised: () => {
        compromised = true;
      },
    });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ELOCKED"
    ) {
      throw new AiQaError(
        "storage.lock_contended",
        "Another ai-qa process holds this lock",
        { path },
        { retryable: true },
      );
    }
    throw error;
  }
  const signal: LockSignal = { compromised: () => compromised };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await callback(signal) };
  } catch (error: unknown) {
    outcome = { ok: false, error };
  }
  try {
    await release();
  } catch (error: unknown) {
    if (!compromised) throw error;
  }
  if (compromised) {
    throw new AiQaError(
      "storage.lock_compromised",
      "The lock was compromised while the operation ran; its outcome is unknown",
      { path },
    );
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
```

Adjust exact copy against `proper-lockfile`'s option contract while implementing (`update` defaults to `stale / 2`); the observable behavior in the tests is binding.

- [ ] **Step 4: Migrate the nine call sites**

Convert each `const release = await lockfile.lock(...); try { ... } finally { await release(); }` block into `await withLock(path, profile, async (signal) => { ... })`. Profiles: `src/core/runs/journal.ts` uses `hot`; the other eight use `cold`. The journal's private `lock()` method disappears; `readLocked` and `appendPrepared` wrap their bodies in `withLock` directly, keeping the existing `requireProjectLocalRegularFile` pre-check and missing-run translation exactly as-is around the `withLock` call. `src/core/cases/repository.ts:507/513` keeps its nested order (directory outer, index inner) as nested `withLock` calls.

The compromise guard is universal, not journal-only. Add to `locking.ts`:

```ts
export function assertNotCompromised(signal: LockSignal, path: string): void {
  if (signal.compromised()) {
    throw new AiQaError(
      "storage.lock_compromised",
      "The lock was compromised before the write could commit",
      { path },
    );
  }
}
```

Every callback that writes must guard each commit operation inside the lock. Checking before *calling* a helper is not enough for atomic writes: `atomicWriteFile`'s real commit is its internal `rename` (`src/core/fs/atomic-write.ts:18`), and a compromise during the temp write/fsync would let a stale writer rename over a newer writer. Therefore, in this task:

- `atomicWriteFile(path, content, options?: { preCommit?: () => void })` invokes `options.preCommit` immediately before the `rename`; a throwing `preCommit` aborts with the temp file cleaned up and the target untouched.
- `writeJsonLines(path, records, options?)` gains and propagates the same option.
- Guarded call sites pass `{ preCommit: () => assertNotCompromised(signal, path) }` to every `atomicWriteFile`/`writeJsonLines` inside a lock, and call `assertNotCompromised` directly before each bare `rename`, `unlink`, and (later) journal line append. That applies to all nine call sites: cases, reports, evidence, RunGroup, and runs writes included. Read-only callbacks may ignore the signal. Nested locks combine guards: the inner callback's `preCommit` checks both signals (`assertNotCompromised(outerSignal, outerPath); assertNotCompromised(innerSignal, innerPath);`).

Add `src/core/fs/atomic-write.ts` and `src/core/fs/json-lines.ts` to this task's Files list. Extend `tests/unit/locking.test.ts` with two cases: (1) a `withLock` callback that deletes the lockfile, waits for `signal.compromised()` to flip, then calls `assertNotCompromised` must throw `storage.lock_compromised` without performing its write; (2) `atomicWriteFile` with a `preCommit` that throws must leave the pre-existing target byte-identical and no `*.tmp` file behind — this pins the compromise-between-sync-and-rename window.

- [ ] **Step 5: Run the affected suites and commit**

Run: `pnpm vitest run tests/unit/locking.test.ts tests/integration && pnpm typecheck`
Expected: PASS.

```bash
git add src/core tests/unit/locking.test.ts
git commit -m "feat: operation-scoped locking with contention and compromise codes"
```

### Task 4: Stop swallowing causes

**Files:**
- Modify: `src/core/runs/journal.ts:98-104` (`readAll` catch)
- Modify: `src/services/run-protocol/run-protocol-service.ts:1045-1047` (`validateProtocolEvents` catch) and `1050-1055` (`protocolIntegrityError`)
- Modify: `src/services/case-promotion/draft-case.ts:379-381`
- Modify: `tests/integration/run-journal.test.ts`

**Interfaces:**
- Consumes: `AiQaError` with `details.cause` support from Task 1.
- Produces: `ErrorCause = { code: string; message: string }` exported from `src/core/errors.ts`, plus `toErrorCause(error: unknown): ErrorCause` — `code` is the nested `AiQaError` code, the Node `errno` code, `"json.parse_error"` for `SyntaxError` from `JSON.parse`, or `"parse_error"` otherwise; `message` is the error message. This is the spec's structured `details.cause` shape; every wrap site in this plan uses it (Task 2's `input.invalid_json` cause switches to it as part of this task).
- Produces: `journal.integrity_error` and `run_protocol.integrity_error` always carry `details.cause` (`ErrorCause`); nested `AiQaError`s propagate unchanged.

- [ ] **Step 1: Write failing tests**

In `tests/integration/run-journal.test.ts` add:

```ts
it("preserves the cause when journal parsing fails", async () => {
  // Arrange a run whose events.jsonl contains a newline-terminated non-JSON line,
  // using the existing run fixture helpers in this file.
  const error = await journal.readAll().catch((thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(AiQaError);
  expect((error as AiQaError).code).toBe("journal.integrity_error");
  expect((error as AiQaError).details.cause).toEqual({
    code: expect.any(String),
    message: expect.any(String),
  });
});

it("surfaces filesystem failures as filesystem.operation_failed", async () => {
  // Arrange: chmod the events file to 0o000, then call readAll.
  const error = await journal.readAll().catch((thrown: unknown) => thrown);
  expect((error as AiQaError).code).toBe("filesystem.operation_failed");
});
```

Follow the file's existing fixture setup for creating a run and locating its `events.jsonl`; skip the chmod test on platforms where the test process runs as root (`process.getuid?.() === 0`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/integration/run-journal.test.ts`
Expected: FAIL — both cases currently collapse to bare `journal.integrity_error`.

- [ ] **Step 3: Implement**

`src/core/runs/journal.ts` `readAll` catch becomes:

```ts
} catch (error: unknown) {
  if (error instanceof AiQaError) throw error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    (error as NodeJS.ErrnoException).code !== undefined
  ) {
    throw normalizeUnknownError(error);
  }
  throw new AiQaError(
    "journal.integrity_error",
    "Run journal integrity verification failed",
    { runId: this.runId, cause: toErrorCause(error) },
  );
}
```

Implement `toErrorCause` in `src/core/errors.ts` first:

```ts
export interface ErrorCause {
  readonly code: string;
  readonly message: string;
}

export function toErrorCause(error: unknown): ErrorCause {
  if (error instanceof AiQaError) {
    return { code: error.code, message: error.message };
  }
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    return {
      code: (error as NodeJS.ErrnoException).code as string,
      message: error.message,
    };
  }
  if (error instanceof SyntaxError) {
    return { code: "json.parse_error", message: error.message };
  }
  return {
    code: "parse_error",
    message: error instanceof Error ? error.message : String(error),
  };
}
```

Then switch Task 2's `readJsonInput` `input.invalid_json` details from `cause: error.message` to `cause: toErrorCause(error)`, and update its test to expect the structured shape.

Note: Zod parse failures inside `readJsonLines` are not Node errors and fall through to `journal.integrity_error` with their message as `cause`. Keep `throwMissingRunOrJournal` behavior unchanged.

In `run-protocol-service.ts`, the `validateProtocolEvents` catch (`:1045-1047`) becomes: rethrow `error instanceof AiQaError` unchanged; wrap anything else via `protocolIntegrityError(error)`, where `protocolIntegrityError` gains a `cause: unknown` parameter and includes `cause: toErrorCause(error)` in details.

In `draft-case.ts:379-381`, rethrow `AiQaError` unchanged and attach `cause: toErrorCause(error)` for the wrapped case.

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/integration tests/unit && pnpm typecheck`
Expected: PASS (update any test pinning a bare integrity error's `details` to tolerate the added `cause`).

```bash
git add src/core/runs/journal.ts src/services tests
git commit -m "fix: preserve causes in integrity errors instead of swallowing them"
```

---

## Milestone 2: Typed run events

### Task 5: Extract the dependency-free ID module

**Files:**
- Create: `src/core/runs/ids.ts`
- Modify: `src/core/runs/schema.ts`, `src/core/runs/event-payloads.ts`, `src/core/runs/lifecycle.ts`, `src/core/verdicts/schema.ts`

**Interfaces:**
- Produces: `src/core/runs/ids.ts` exporting exactly `criterionIdSchema`, `eventIdSchema`, `actionIdSchema`, `stepIdSchema`, `runIdSchema` — moved verbatim from `src/core/runs/schema.ts:16-47`, importing only `zod`.
- Produces: `src/core/runs/schema.ts` re-exports all five (`export * from "./ids.js";`) so every existing importer keeps compiling unchanged.
- Cycle constraint (binding): every module that Task 6's union will make `runs/schema.ts` import — directly or transitively — must take its ID schemas from `ids.ts`, not `schema.ts`. The transitive chain runs `runs/schema.ts → event-payloads.ts → evidence/schema.ts` and `runs/schema.ts → verdicts/schema.ts → evidence/schema.ts`, and `src/core/evidence/schema.ts:5` currently imports `actionIdSchema`, `runIdSchema` from `../runs/schema.js` — that import must migrate too or Milestone 2 ships an ESM cycle.

- [ ] **Step 1: Move the schemas**

Create `src/core/runs/ids.ts` containing the five ID schema declarations copied verbatim from `schema.ts` (with `import { z } from "zod";`). In `schema.ts`, delete those declarations and add `export * from "./ids.js";` at the top of the export section. Switch the payload-side imports to the new module:

- `src/core/runs/event-payloads.ts:4-9`: import `actionIdSchema`, `criterionIdSchema`, `eventIdSchema`, `stepIdSchema` from `./ids.js`.
- `src/core/runs/lifecycle.ts:4`: import `eventIdSchema` from `./ids.js` (keep the `RunEvent` type import from `./schema.js` for now; it moves in Task 6).
- `src/core/verdicts/schema.ts:3`: import `criterionIdSchema`, `eventIdSchema` from `../runs/ids.js`.
- `src/core/evidence/schema.ts:5`: import `actionIdSchema`, `runIdSchema` from `../runs/ids.js`.

- [ ] **Step 2: Verify no behavior change**

Run: `pnpm typecheck && pnpm vitest run tests/unit`
Expected: PASS with zero test edits.

- [ ] **Step 3: Commit**

```bash
git add src/core
git commit -m "refactor: extract run ID schemas into a dependency-free module"
```

### Task 6: Discriminated-union `runEventSchema`

**Files:**
- Modify: `src/core/runs/lifecycle.ts` (export `lifecyclePayloadSchema`; break the type-import cycle)
- Modify: `src/core/runs/schema.ts:343-375`
- Create: `tests/unit/run-event-schema.test.ts`

**Interfaces:**
- Consumes: `actionPayloadSchema`, `observationPayloadSchema`, `assertionPayloadSchema`, `decisionPayloadSchema`, `recoveryPayloadSchema`, `evidenceEventPayloadSchema` from `event-payloads.ts`; `blockerPayloadSchema`, `verdictPayloadSchema` from `verdicts/schema.ts`; `lifecyclePayloadSchema` from `lifecycle.ts`.
- Produces: `runEventSchema` as a `z.discriminatedUnion("type", [...])` with one member per event type; `RunEvent = z.infer<typeof runEventSchema>`; `AppendRunEvent` as a distributive omit preserving the `type`↔`payload` correlation:

```ts
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;
export type AppendRunEvent = DistributiveOmit<
  RunEvent,
  "schemaVersion" | "id" | "runId" | "sequence" | "timestamp"
>;
```

- [ ] **Step 1: Write failing round-trip tests**

Create `tests/unit/run-event-schema.test.ts` with one `runEventSchema.parse` case per event type (`run` with a `started` payload, `action` planned, `observation`, `assertion`, `evidence`, `decision`, `blocker`, `verdict`, `recovery`), each asserting the parse succeeds and `parsed.type` narrows `parsed.payload` (compile-time check via a `switch` on `type` that reads a payload-specific field per branch). Add one negative case: an `action` event carrying an observation payload must fail. Copy realistic payload literals from the fixtures already used in `tests/integration/typed-protocol.test.ts`. Add a compatibility case: an event object shaped exactly like one produced by the current 0.1.0 code (schemaVersion 2, string tool, relatedIds) still parses.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/run-event-schema.test.ts`
Expected: FAIL — the mismatched-payload case passes under the current permissive schema.

- [ ] **Step 3: Implement the union**

In `lifecycle.ts`: change `const lifecyclePayloadSchema` (`:43`) to `export const`, and replace the `import { eventIdSchema, type RunEvent } from "./schema.js"` with `import { eventIdSchema } from "./ids.js";` plus a structural event parameter for `validateRunLifecycleHistory` (it only needs `{ payload: LifecyclePayload; id: string; timestamp: string }`-shaped input — read its body and type the parameter to precisely the fields it touches, breaking the import cycle).

In `schema.ts`, replace `runEventSchema`/`RunEvent`/`AppendRunEvent` (`:343-375`) with a shared base shape object and the discriminated union:

```ts
const runEventBase = {
  schemaVersion: z.literal(EVENT_SCHEMA_VERSION),
  id: eventIdSchema,
  runId: runIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  actor: z.enum(["agent", "user", "ai-qa"]),
  platform: platformSchema,
  tool: z.string(),
  idempotencyKey: z.string().optional(),
  relatedIds: z.array(z.string()),
};

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ ...runEventBase, type: z.literal("run"), payload: lifecyclePayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("action"), payload: actionPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("observation"), payload: observationPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("assertion"), payload: assertionPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("evidence"), payload: evidenceEventPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("decision"), payload: decisionPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("blocker"), payload: blockerPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("verdict"), payload: verdictPayloadSchema }).strict(),
  z.object({ ...runEventBase, type: z.literal("recovery"), payload: recoveryPayloadSchema }).strict(),
]);
```

Import direction check before committing: `schema.ts` now imports `event-payloads.ts`, `lifecycle.ts`, and `verdicts/schema.ts`; none of those three — nor their transitive dependency `evidence/schema.ts` — may import `schema.ts` (they import `ids.ts`; Task 5 migrated all four). Verify with `grep -rn "runs/schema.js\|from \"./schema.js\"" src/core/runs/event-payloads.ts src/core/runs/lifecycle.ts src/core/verdicts/schema.ts src/core/evidence/schema.ts` — expected: no matches.

- [ ] **Step 4: Fix the type fallout**

Run `pnpm typecheck` and resolve every error mechanically. Expected fallout classes: (a) code that Zod-parsed `event.payload` (for example `lifecycle.ts:66`) now receives the already-typed payload — keep the parse for now (it is a no-op re-validation removed in Task 7) and cast via the typed accessor instead of `jsonValue`; (b) construction sites (`journal.ts` `appendToSnapshot`, `protocolAppendInput`, `actionAppendInput`, `prospectiveEvent` in `run-protocol-service.ts`) now need the discriminated `AppendRunEvent` — their existing `{ type, payload }` pairs already correlate, so annotate rather than restructure; (c) tests constructing events with mismatched payloads must be corrected. Do not weaken any payload schema to make fallout compile.

- [ ] **Step 5: Run everything and commit**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

```bash
git add src tests
git commit -m "feat: type run events with a discriminated payload union"
```

---

## Milestone 3: RunSession and append-only journal

### Task 7: Single-pass validators

**Files:**
- Modify: `src/services/run-protocol/run-protocol-service.ts` (`validateProtocolEvents:805`, `requireRecoveryRetryPermitted:631`, `plannedActions:560`, `terminalActions:568`)
- Modify: `src/services/run-protocol/regression-fidelity.ts:166-168` and `src/services/run-protocol/effective-interactions.ts`
- Modify: `tests/integration/run-hardening.test.ts`

**Interfaces:**
- Produces: `validateProtocolEvents(events: readonly RunEvent[], workOrder: Readonly<WorkOrder>): void` — same external contract, internally one pass. Recovery-retry permission and effective-interaction counting become fold state threaded through the event loop instead of `events.slice(0, index)` rescans.

- [ ] **Step 1: Pin behavior with a parity test**

In `tests/integration/run-hardening.test.ts`, add a test that builds a run journal with: a planned+completed interaction, a failed interaction, a recovery event, a retried interaction, and asserts `validateProtocolEvents` accepts it; plus the existing negative recovery cases in that file must keep passing untouched. These pin the semantics before the rewrite. Then add a budget-size journal (100 planned/completed interaction pairs with observations) and assert validation completes in under 2 seconds:

```ts
it("validates a budget-sized journal quickly", () => {
  const events = buildBudgetSizedJournal(); // helper in this file: 100 steps of plan/complete/observation
  const startedAt = performance.now();
  validateProtocolEvents(events, workOrder);
  expect(performance.now() - startedAt).toBeLessThan(2_000);
});
```

- [ ] **Step 2: Run to verify the perf pin currently holds or fails honestly**

Run: `pnpm vitest run tests/integration/run-hardening.test.ts`
Expected: the parity cases PASS against current code (they are regression pins, written first so the rewrite is provably behavior-preserving); the perf case may already pass at n=100 — keep it as a guardrail either way.

- [ ] **Step 3: Rewrite the rescans as fold state**

Inside `validateProtocolEvents`'s event loop, replace each `requireRecoveryRetryPermitted(events.slice(0, index), ...)` call with an accumulator object created before the loop and updated per event; `requireRecoveryRetryPermitted` becomes a method-style function over that accumulator with the same throw behavior (`retryNotPermitted` unchanged). Apply the same transformation to `validateRegressionFidelity`'s per-recovery `effectiveInteractionSuccesses(events.slice(0, index + 1))`: maintain the running success count in the loop. Read each current implementation first and preserve its exact predicate — the parity tests from Step 1 are the safety net. Delete the now-unused `slice`-taking variants.

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run tests/integration tests/unit && pnpm typecheck`
Expected: PASS.

```bash
git add src/services tests
git commit -m "perf: single-pass protocol and fidelity validation"
```

### Task 8: Append-only journal writes and torn-tail classification

Journal primitives land before RunSession (Task 9) needs them; this task keeps the existing `appendPrepared`/`appendToSnapshot` entry points alive and behavior-identical, only swapping their write mechanics.

**Files:**
- Modify: `src/core/runs/journal.ts`
- Create: `tests/unit/journal-append.test.ts`

**Interfaces:**
- Produces (on `RunJournal`): `appendLine(event: RunEvent, signal: LockSignal): Promise<void>` — opens `events.jsonl` with flag `"a"`, calls `assertNotCompromised(signal, path)` immediately before writing, writes `` `${JSON.stringify(event)}\n` ``, fsyncs via the handle, closes. `appendBatch(events: readonly RunEvent[], priorEvents: readonly RunEvent[], signal: LockSignal): Promise<void>` — calls `assertNotCompromised(signal, path)` immediately before `writeJsonLines(path, [...priorEvents, ...events])` (existing atomic rewrite), then directory-fsyncs. Both primitives are compromise-guarded; there is no unguarded commit path.
- Produces (in `journal.ts`, private): `classifyJournalTail(content: Buffer): { kind: "ok"; complete: Buffer } | { kind: "torn"; complete: Buffer; tailOffset: number; tailBytes: Buffer }` — operates on raw bytes, never on a decoded string, because `ftruncate` offsets are bytes and a truncated multi-byte UTF-8 sequence must survive classification losslessly. `torn` iff the buffer is non-empty and its last byte is not `0x0a`; `tailOffset` is the byte offset after the last `0x0a` (or 0); `complete` is the newline-terminated prefix, which is the only region ever decoded — via `new TextDecoder("utf-8", { fatal: true }).decode(complete)`, never `Buffer.toString("utf8")`, because the lossy decoder replaces malformed bytes with U+FFFD and corruption inside a JSON string value would then parse cleanly and be silently accepted. A fatal-decode failure or a decoded line that fails `JSON.parse` remains `journal.integrity_error` via Task 4's catch.
- Produces: `readAll` reads the file as a Buffer, classifies first: `torn` → `AiQaError("journal.torn_write", "Run journal has an unacknowledged torn tail; run \"ai-qa run repair <run-id>\"", { runId, tailOffset })`; otherwise parse the complete region and run the existing invariant loop. `appendPrepared` internally routes its single-event write through `appendLine` (replacing the full-file rewrite in `appendToSnapshot`), so existing callers keep working unchanged until Task 9 migrates them.

- [ ] **Step 1: Write failing tests**

Create `tests/unit/journal-append.test.ts` with a temp-dir run journal (reuse `tests/helpers/project-fixture.ts` scaffolding):

```ts
it("appends a single event without rewriting the file", async () => {
  // Append 3 events via journal.appendPrepared. After event 1, record the
  // file's inode (fs.stat().ino) and size. After events 2 and 3, assert the
  // inode is unchanged and the size strictly grew.
});

it("classifies the four tail states", async () => {
  // (a) valid file -> readAll succeeds
  // (b) complete JSON tail without trailing newline -> journal.torn_write
  // (c) invalid bytes without trailing newline (truncated multi-byte UTF-8:
  //     write a valid event line, then append Buffer.from([0xe4, 0xb8])) -> journal.torn_write
  // (d) invalid JSON line WITH trailing newline -> journal.integrity_error
  // (e) malformed UTF-8 INSIDE a newline-terminated line (take a valid event
  //     line containing "測", corrupt one of that character's bytes to 0xff,
  //     keep the trailing newline) -> journal.integrity_error from the fatal
  //     decoder, NOT a silent parse of a U+FFFD-substituted string.
  // For (b) and (c) also assert details.tailOffset equals the BYTE length of
  // the newline-terminated prefix — include a non-ASCII character ("測")
  // inside an earlier event's intent string so a UTF-16 index would be wrong.
});

it("uses the atomic rewrite for batches", async () => {
  // Call journal.appendBatch directly with two event literals and the prior
  // events; assert the inode CHANGED versus before the batch (rename replaced
  // the file) and the journal parses completely.
});

it("leaves zero of a batch's events when the batch write crashes", async () => {
  // vi.spyOn(await import("node:fs/promises"), "rename").mockRejectedValueOnce(
  //   new Error("injected crash"),
  // ) so the atomic rewrite fails after the temp write. Call appendBatch: it
  // must reject, events.jsonl must byte-equal its pre-batch content (zero
  // batch events), and no *.tmp file may remain. Restore the spy, retry the
  // appendBatch, and assert the journal now contains ALL batch events.
});
```

Write each case fully with real event literals (copy shapes from `tests/unit/run-event-schema.test.ts`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run tests/unit/journal-append.test.ts`
Expected: FAIL — inode changes on every append today; torn tails currently raise `journal.integrity_error`; the batch primitives do not exist.

- [ ] **Step 3: Implement**

Implement `classifyJournalTail` as a pure Buffer function in `journal.ts` (use `content.lastIndexOf(0x0a)`); `readAll` switches from `readJsonLines` to reading the Buffer, classifying, then decoding and parsing only the complete region with `runEventSchema` and the existing invariant loop. Implement `appendLine`/`appendBatch` as specified; rewire `appendToSnapshot`'s write to `appendLine` (single events) while leaving its invariant enforcement in place for now (it moves into RunSession in Task 9). For the batch path's directory fsync, copy the exact pattern from `syncDirectoryWhereSupported` in `src/core/runs/repository.ts`.

- [ ] **Step 4: Run and commit**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

```bash
git add src/core tests
git commit -m "perf: append-only single-event journal writes with torn-tail classification"
```

### Task 9: RunSession

**Files:**
- Create: `src/services/run-protocol/run-session.ts`
- Modify: `src/services/run-protocol/run-protocol-service.ts` (`appendValidated:379`), `read-run-state.ts`, `run-lifecycle.ts` (`cancelRun:99-166`, `resumeRun`), `finalize-run.ts`, `verdict-service.ts`, `register-evidence.ts`
- Modify: `src/cli/commands/protocol-helpers.ts`
- Modify: `src/core/runs/repository.ts` (`readVerifiedWorkOrder:166-170`)
- Modify: `src/core/runs/journal.ts` (delete `appendPrepared`/`appendToSnapshot` once the last caller migrates)

**Interfaces:**
- Produces (from `run-session.ts`):

```ts
export interface RunSnapshot {
  readonly workOrder: Readonly<WorkOrder>;
  readonly events: readonly RunEvent[];
  readonly lifecycle: LifecycleState; // derived: current phase + effective verdict, computed once
}
export function validateRunSnapshot(snapshot: RunSnapshot): void;
// Aggregate of ALL run validators: validateProtocolEvents, the lifecycle
// history validation (core/runs/lifecycle.ts:58), verdict/blocker history
// validation (verdict-service.ts), and — for regression work orders —
// validateRegressionFidelity. One call is the complete validity check.
export interface ProtocolCommandResult {
  readonly event: RunEvent;
  readonly state: RunStateSummary; // { status, effectiveVerdict?, requiresFreshObservation }
  readonly permittedNextActions: readonly string[];
}
export async function withRunSession<T>(
  input: { projectRoot: string; runId: string; now: () => Date },
  callback: (session: RunSession) => Promise<T>,
): Promise<T>;
export interface RunSession {
  readonly snapshot: RunSnapshot;
  append(inputs: readonly AppendRunEvent[]): Promise<readonly RunEvent[]>; // validates, writes, refreshes snapshot
  state(): RunStateSummary & { permittedNextActions: readonly string[] };
}
```

- `withRunSession` acquires the journal `hot` lock once (via `withLock`), first calls `requireNoIncompleteRepair(projectRoot, runId)` (Task 11 supplies it; until then the session omits the gate), reads and parses events once, calls `readVerifiedWorkOrder(projectRoot, runId, events)` (new signature: takes the parsed events, does not re-read the journal — change `src/core/runs/repository.ts:166-170` accordingly), and assembles the snapshot. `withRunSession` runs `validateRunSnapshot` once at open. `append` enforces the idempotency/sequence/platform invariants (moved out of `appendToSnapshot`), builds the prospective snapshot (current events plus the new batch, with lifecycle re-derived), runs `validateRunSnapshot` on it — the full aggregate, not just `validateProtocolEvents`, because lifecycle, blocker/verdict-history, and regression-fidelity violations must reject BEFORE anything is persisted — and only then writes via the Task 8 primitives (`appendLine` for one event, `appendBatch` for more, both receiving the session's `LockSignal`) and adopts the prospective snapshot as current.
- `RunProtocolService` methods (`planAction`, `completeAction`, `addObservation`, `recordAssertion`, `recordDecision`, `resolveUnknownAction`) change return type from `Promise<RunEvent>` to `Promise<ProtocolCommandResult>`, computed inside the session.
- `writeProtocolEvent` in `protocol-helpers.ts` takes a `ProtocolCommandResult` and prints it; it no longer calls `resolveProject` or `readRunState`. Its JSON shape is unchanged.
- `cancelRun` becomes one `withRunSession` whose `append` receives the cancellation verdict event and the `cancelled` lifecycle event as one batch; `resumeRun`'s two lifecycle events likewise.
- Evidence registration migrates into the session in this task: `register-evidence.ts` opens the session (journal `hot` lock), acquires the evidence `cold` lock nested inside it (preserving the global journal→evidence order), and its writes call `assertNotCompromised` against BOTH signals before each commit. With that last caller migrated, delete `RunJournal.appendPrepared` and `appendToSnapshot`; the primitives from Task 8 are the only write path.

- [ ] **Step 1: Pin the CLI output contract**

In `tests/integration/typed-protocol.test.ts`, confirm existing assertions cover the printed shape of a protocol command (`eventId`, `sequence`, `payload`, `state`, `permittedNextActions`). Add one if absent. These must pass unchanged after the refactor.

- [ ] **Step 2: Add a read-back atomicity test**

In `tests/integration/run-hardening.test.ts`:

```ts
it("returns state computed from the same critical section as the append", async () => {
  // Start a run; issue action plan; before reading the CLI output, append a
  // concurrent event directly via a second RunJournal handle; assert the
  // command's printed sequence and state reflect only its own append.
});
```

Implement with the file's existing direct-journal helpers; the assertion is that the printed `sequence` equals the planned event's sequence (not the concurrent writer's) and `permittedNextActions` matches the state immediately after that event.

- [ ] **Step 3: Implement `run-session.ts` and migrate**

Order of migration: (1) change `readVerifiedWorkOrder` to accept events; (2) implement `validateRunSnapshot` (compose the four existing validators over a snapshot; no semantic changes) and `withRunSession`/`append`/`state` (move invariant enforcement out of `appendToSnapshot`; derive lifecycle state into the snapshot once; `state()` reuses the logic currently in `read-run-state.ts`, which becomes a pure function over `RunSnapshot` exported as `deriveRunState(snapshot): RunStateSummary & { permittedNextActions }`); (3) convert `RunProtocolService.appendValidated` to run inside the session and return `ProtocolCommandResult`; (4) convert `cancelRun`/`resumeRun` to session batches; (5) update `protocol-helpers.ts` and every `src/cli/commands/*.ts` caller of `writeProtocolEvent`; (6) update `finalize-run.ts` and `verdict-service.ts` to open a session instead of doing their own lock+read+validate; (7) migrate `register-evidence.ts` into the session with the nested evidence lock and dual-signal guards; (8) delete `RunJournal.appendPrepared` and `appendToSnapshot` and fix the remaining compile errors. Keep each sub-step compiling; run `pnpm typecheck` between them.

- [ ] **Step 4: Cancel single-critical-section test**

In `tests/integration/run-hardening.test.ts`:

```ts
it("commits cancellation verdict and lifecycle together", async () => {
  // Cancel a running run, then read the raw journal: the cancellation verdict
  // event and the cancelled lifecycle event must be adjacent, and re-reading
  // state must be terminal. No observable state may exist where the verdict
  // is present without the lifecycle event (assert via the journal contents).
});

it("persists nothing when a batch fails aggregate validation", async () => {
  // Build a session batch that passes validateProtocolEvents but violates
  // lifecycle history (e.g. a cancelled lifecycle event on an already-
  // completed run). session.append must reject, and the raw journal must
  // byte-equal its pre-append content — the aggregate validator runs BEFORE
  // the write, so no invalid event is ever persisted.
});
```

- [ ] **Step 5: Run everything and commit**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS, including the unchanged CLI-output pins from Step 1.

```bash
git add src tests
git commit -m "refactor: RunSession gives every command one lock, one read, one validation"
```

---

## Milestone 4: Repair, RunGroup staging, cleanup, release

### Task 10: Orphan-aware evidence parity

**Files:**
- Modify: `src/core/evidence/parity.ts`
- Modify: `src/services/run-protocol/register-evidence.ts:165-174` (drop post-append `verifyAll`)
- Modify: `src/services/run-protocol/run-lifecycle.ts:44-77` (resume: structural parity only)
- Modify: `tests/unit/evidence-parity.test.ts`, `tests/integration/evidence.test.ts`

**Interfaces:**
- Produces: `validateEvidenceParity` classifies in three tiers: (1) index entries with no matching journal evidence event → `AiQaError("evidence.orphaned_entries", "Evidence index contains entries with no journal event; run \"ai-qa run repair <run-id>\"", { runId, orphanedEvidenceIds })`; (2) journal evidence events missing from the index → `evidence.integrity_error` (unchanged); (3) for every ID present in both, the existing canonical record comparison (`parity.ts:38`) is RETAINED — a shared ID whose index record and journal payload differ in hash, path, capture action, or any other field remains `evidence.integrity_error`, never an orphan. ID-set differences classify; they do not replace content comparison. Full content-hash verification (`verifyAll`) runs only in `finalize-run.ts` and `generate-run-report.ts`.

- [ ] **Step 1: Write failing tests**

In `tests/unit/evidence-parity.test.ts`: build an index/journal pair where the index has one extra trailing entry → expect `evidence.orphaned_entries` with the orphaned ID; build the reverse (journal has an event the index lacks) → expect `evidence.integrity_error`; build a pair sharing an ID whose index record carries a different `contentHash` than the journal payload → expect `evidence.integrity_error`, not an orphan (the same-ID/different-content regression pin). In `tests/integration/evidence.test.ts`: register evidence, then delete the run's last journal event line directly (simulating the crash window), and assert `evidence add`, `run resume`, and `run finish` all fail with `evidence.orphaned_entries` naming the repair command — not `evidence.integrity_error`.

- [ ] **Step 2: Run to verify failure, implement, re-run**

Run: `pnpm vitest run tests/unit/evidence-parity.test.ts tests/integration/evidence.test.ts`
Implement the classification split in `parity.ts`: compute the ID-set difference first (extra index IDs → orphans, missing index IDs → integrity error), then run the existing canonical record comparison unchanged over the intersection. Remove the `verifyAll` call from `register-evidence.ts:165-174`; change resume to call parity validation without hashing; confirm `finalize-run.ts:70` and `generate-run-report.ts:243` still call `verifyAll`.
Expected after implementation: PASS, plus the pre-existing 700 ms sleep test in `evidence.test.ts` still green.

- [ ] **Step 3: Commit**

```bash
git add src tests
git commit -m "feat: classify orphaned evidence as repairable; hash only at finish and report"
```

### Task 11: `ai-qa run repair`

**Files:**
- Create: `src/services/run-repair/repair-run.ts`
- Create: `src/cli/commands/repair.ts`
- Modify: `src/cli/program.ts` (register), `src/cli/commands/run.ts` (no change to start; `run repair` lives in `repair.ts` under the existing `run` command group — read how `run.ts` builds the group and attach there instead if commander requires a single parent; either way the invocable surface is `ai-qa run repair <run-id>`)
- Modify: `src/services/run-protocol/run-session.ts` (incomplete-manifest gate at session open), `src/services/report-generation/generate-run-report.ts`, `src/services/case-promotion/draft-case.ts` (gate for the non-session readers)
- Create: `tests/integration/run-repair.test.ts`

**Interfaces:**
- Produces: `repairRun(input: { projectRoot: string; runId: string; now: () => Date }): Promise<RepairReport>` with

```ts
export interface RepairReport {
  readonly runId: string;
  readonly relocated: readonly {
    kind: "evidence-file" | "evidence-index-entry" | "journal-tail";
    reference: string; // evidence ID or "events.jsonl@<offset>"
    recoveryPath: string; // project-relative
  }[];
}
```

- Produces: manifest file `.ai-qa/recovery/<run-id>/repair-manifest.json` validated by a Zod schema in `repair-run.ts`:

```ts
import { normalizedRelativePosixPathSchema } from "../../core/evidence/schema.js";

const repairRelocationSchema = z
  .object({
    kind: z.enum(["evidence-file", "evidence-index-entry", "journal-tail"]),
    evidenceId: z.string().optional(), // absent for journal-tail
    sourcePath: normalizedRelativePosixPathSchema, // for index entries, the index file
    recoveryPath: normalizedRelativePosixPathSchema,
    contentHash: z.string(), // sha256 of the bytes being relocated, captured at plan time
  })
  .strict()
  .superRefine((relocation, context) => {
    // Kind-specific root constraints — a reloaded manifest is untrusted input.
    // sourcePath must start with ".ai-qa/evidence/" (evidence-file,
    // evidence-index-entry) or ".ai-qa/runs/" (journal-tail); recoveryPath
    // must start with ".ai-qa/recovery/". Reject anything else with a custom
    // issue; the exact prefixes are asserted by the malicious-manifest tests.
  });

const repairManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: runIdSchema,
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    relocations: z.array(repairRelocationSchema),
    journalTail: z
      .object({
        truncateOffset: z.number().int().nonnegative(), // bytes
        byteLength: z.number().int().positive(),
        contentHash: z.string(),
      })
      .strict()
      .optional(),
    orphanedEvidenceIds: z.array(z.string()),
  })
  .strict();
```

The manifest must be self-sufficient for recovery after the index entries and source files are gone: every relocation records its source path, recovery path, and expected content hash, so a resumed repair can verify each copy by hashing the destination, decide index-rewrite completion by checking the orphan IDs' absence, decide truncation by comparing the journal's byte length to `truncateOffset`, and decide source deletion by existence — without consulting any state the earlier steps destroyed.

A reloaded manifest is untrusted: it persisted across a crash and could be corrupted or tampered with, and repair copies and deletes whatever it names. Beyond the schema constraints above, every path is resolved through the project-storage containment helpers before each operation — use `requireProjectLocalRegularFile` / the descendant- and symlink-safe checks in `src/core/fs/project-storage.ts` exactly as `clear-project.ts` does — so a manifest naming an escaping or symlinked path fails with `storage.integrity_error` before any I/O.

- Produces: `requireNoIncompleteRepair(projectRoot: string, runId: string): Promise<void>` exported from `repair-run.ts`, throwing `AiQaError("run.repair_incomplete", "An interrupted repair exists; run \"ai-qa run repair <run-id>\"", { runId })` when a manifest exists without `completedAt`. The gate must cover every path that reads or mutates the run, with `repairRun` itself as the sole bypass: wire it (1) into `withRunSession` (Task 9 left the hook point) — this covers every protocol command, state read, verdict, cancel/resume, finish, and evidence registration in one place — and (2) into the non-session readers: `generate-run-report.ts` and `draft-case.ts` (case promotion). Do not wire it anywhere else piecemeal; if a future reader bypasses the session, it must call the gate itself.
- Protocol (spec-binding): under `withLock(journal, "hot", ...)` then nested `withLock(evidenceIndex, "cold", ...)`: (1) compute plan, atomically write manifest; (2) copy orphaned evidence files and the torn tail bytes into the recovery directory; (3) atomically rewrite the index without orphans; (4) `ftruncate` the journal at the offset; (5) delete orphaned source files; (6) atomically rewrite the manifest with `completedAt`. Every write step (manifest writes, copies, index rewrite, truncate, deletes) calls `assertNotCompromised` against both lock signals immediately before committing. A rerun with an incomplete manifest re-executes from the manifest's plan; every step is a no-op when its effect already holds (copy verifies the destination against the manifest's `contentHash`, index rewrite checks the orphan IDs' absence, truncate compares the journal byte length to `truncateOffset`, delete checks existence).

- [ ] **Step 1: Write failing tests**

Create `tests/integration/run-repair.test.ts`:

```ts
it("repairs an orphaned evidence entry and reports it");
// Arrange the Task-10 crash state; run repairRun; assert: index has no orphan,
// evidence file moved under .ai-qa/recovery/<run-id>/, report lists both
// relocations, and run resume + finish now succeed.

it("repairs a torn journal tail");
// Append raw partial bytes to events.jsonl; repairRun; assert journal parses,
// tail bytes exist under recovery, report lists journal-tail@offset.

it("is idempotent on a clean run");
// repairRun twice on a healthy run: both return { relocated: [] }.

it("resumes deterministically from every crash boundary");
// For each of the five boundary states — (1) manifest written only;
// (2) + copies done; (3) + index rewritten; (4) + journal truncated;
// (5) + sources deleted, completedAt still absent — construct the on-disk
// state by hand, run repairRun, and assert the final state is byte-identical
// to the uninterrupted repair's final state.

it("blocks every run consumer while a repair is incomplete");
// Write a manifest without completedAt; expect action plan, evidence add,
// verdict set, run resume, run finish, report generate, and case draft
// --from-run to all fail with run.repair_incomplete, and repairRun itself
// to proceed.

it("does not deadlock against concurrent evidence registration");
// Run repairRun and an evidence add concurrently 20 times; both must settle
// (either order), never hang. Guard with a 15s timeout.

it("refuses a malicious or corrupted manifest before any I/O");
// Three sub-cases, each writing a syntactically valid manifest by hand and
// asserting repairRun fails WITHOUT copying, deleting, or truncating anything
// (snapshot the .ai-qa tree before/after and compare):
// (a) sourcePath "../../outside.txt" -> schema rejection;
// (b) recoveryPath ".ai-qa/evidence/<run-id>/file.png" (valid shape, wrong
//     root for its kind) -> schema rejection;
// (c) schema-valid paths where the recovery directory has been replaced by a
//     symlink pointing outside the project -> storage.integrity_error from
//     the containment helpers.
```

Write each body fully using the project fixture helpers; the boundary-state test builds states with plain `fs` calls mirroring the protocol steps.

- [ ] **Step 2: Run to verify failure, implement service + command, re-run**

Run: `pnpm vitest run tests/integration/run-repair.test.ts`
Implement `repair-run.ts` per the protocol above; `repair.ts` registers `run repair <run-id>`, resolves the project exactly as `protocol-helpers.ts` does, calls `repairRun`, prints the `RepairReport` via `writeJson`. Wire the `requireNoIncompleteRepair` gate into the three readers.
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src tests
git commit -m "feat: crash-safe ai-qa run repair with persistent manifest"
```

### Task 12: RunGroup staging creation and stale-staging sweeps

**Files:**
- Modify: `src/core/run-groups/repository.ts:52-74` (create via staging + rename)
- Modify: `src/services/run-groups/start-run-group.ts`, `src/services/run-protocol/start-exploratory-run.ts` (sweep call), `src/core/runs/repository.ts:77-79` (expose the staging prefix for the sweep)
- Modify: `tests/integration/run-group.test.ts`

**Interfaces:**
- Produces: `RunGroupRepository.create` assembles `group.json` + `events.jsonl` inside `.ai-qa/run-groups/.group-staging-<uuid>/` and renames the directory to the group ID as the commit point; a leftover staging directory is invisible to reads and re-creation.
- Produces: `sweepStaleStaging(root: string, prefix: string, now: () => Date): Promise<string[]>` in `src/core/fs/project-storage.ts` — removes `<prefix>*` directories whose mtime is older than one hour relative to `now()`, returns removed names; called from `run start` (runs root, prefix `.run-staging-`) and `run-group start` (run-groups root, prefix `.group-staging-`).

- [ ] **Step 1: Write failing tests**

In `tests/integration/run-group.test.ts`: (a) simulate the old crash state — create a group directory containing only `events.jsonl` — and assert `run-group start` with a fresh ID succeeds and reading the half-created ID reports `run_group.not_found`; (b) create a `.group-staging-x` directory with an mtime 2 hours old (use `fs.utimes`), call `run-group start`, assert the staging directory is gone; (c) same for a stale `.run-staging-x` under runs with `run start`.

- [ ] **Step 2: Implement, run, commit**

Run: `pnpm vitest run tests/integration/run-group.test.ts tests/integration/run-hardening.test.ts && pnpm typecheck`
Expected: PASS.

```bash
git add src tests
git commit -m "fix: stage-and-rename RunGroup creation; sweep stale staging directories"
```

### Task 13: Cleanup and consolidation

**Files:**
- Create: `src/core/node-errors.ts` (shared `isNodeError`, `isRecord`)
- Delete: `src/core/tools.ts`
- Modify: the 12 `isNodeError` definers (`src/core/evidence/repository.ts`, `src/core/config/repository.ts`, `src/core/recording/repository.ts`, `src/core/cases/repository.ts`, `src/core/run-groups/repository.ts`, `src/core/runs/repository.ts`, `src/core/runs/journal.ts`, `src/core/reports/storage.ts`, `src/core/fs/project-storage.ts`, `src/cli/commands/doctor.ts`, `src/services/project-root/resolve-project-root.ts`, `src/services/doctor/installation-doctor.ts`) and the 6 `isRecord` definers (`src/core/recording/repository.ts`, `src/core/runs/repository.ts`, `src/services/run-protocol/verdict-service.ts`, `src/services/run-protocol/run-protocol-service.ts`, `src/services/run-protocol/run-lifecycle.ts`, `src/services/report-generation/generate-run-report.ts`)
- Modify: `src/core/runs/journal.ts` (export `appendInput`; delete the copies in `run-protocol-service.ts:525`, `verdict-service.ts:328`, `finalize-run.ts:625`), delete `RunJournal.create` (`journal.ts:47-71`)
- Modify: `src/core/run-groups/repository.ts` (delete `readManifest`/`readEvents`), `src/services/skill-management/global-skill.ts:382-394` (delete `checkGlobalSkillForProject`), `src/core/cases/repository.ts` (remove the voided `now` constructor parameter and its caller threading in `draft-case.ts:135,177`; merge `validateRevision`/`validateRevisionAgainstIndex`; fix the double index read in `activate:330-331`), `src/services/project-root/resolve-project-root.ts:69-78` (reduce to an existence check)
- Create: `src/services/run-protocol/pinned-case.ts` (single `validatePinnedRegressionCase`; delete the copies in `finalize-run.ts:305-345` and `generate-run-report.ts:468-507`, keeping the `validateRevision`-based semantics)
- Modify: `src/schemas/versions.ts` (add `RUN_GROUP_SCHEMA_VERSION = 1`, `CASE_INDEX_SCHEMA_VERSION = 1`, `RECORDING_SCHEMA_VERSION = 2`) and replace the inline literals at `run-groups/repository.ts:62,187,248`, `start-run-group.ts:188`, `cases/repository.ts:466`, `recording/repository.ts:124,278`
- Modify: `tests/integration/global-skill.test.ts`, `tests/unit/managed-skill.test.ts`, and any test importing `core/tools.ts` or `RunJournal.create` (re-point to the real modules)

- [ ] **Step 1: Consolidate helpers, delete dead code, migrate imports**

Mechanical sweep in the order listed above, running `pnpm typecheck` after each bullet. The two `validatePinnedRegressionCase` copies differ (manual hash check vs `validateRevision`); the merged `pinned-case.ts` uses `validateRevision`, and the tests in `tests/integration/regression-replay.test.ts` plus `tests/integration/report-generation.test.ts` must stay green to prove the semantics held.

- [ ] **Step 2: Run the full suite and commit**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: PASS; lint confirms no unused-symbol leftovers.

```bash
git add -A src tests
git commit -m "refactor: consolidate helpers, delete dead code, centralize schema version literals"
```

### Task 14: Single-run CI exit codes, version 0.2.0, release gate

**Files:**
- Modify: `src/cli/commands/report.ts`
- Modify: `package.json` (version), `README.md`
- Modify: `tests/cli/group-report-exit.test.ts` (extend for single runs)

**Interfaces:**
- Produces: `requestCiRunFailure(report: RunReport, requestExitCode: (code: number) => void): void` in `report.ts`, mirroring `requestCiGroupFailure:76-88`: exit non-zero when the run's work order has `execution: "ci"` and (the run is not `completed` or its effective verdict classification is not `"pass"`). Wired into `report generate <run-id>` and `report export <run-id>`. A cancelled run is non-pass.

- [ ] **Step 1: Write failing tests**

Extend `tests/cli/group-report-exit.test.ts` (or a sibling `run-report-exit.test.ts` if the file's fixtures are group-only): a CI regression run finished with verdict `fail` → `report generate` exits 1; same with a cancelled run → exits 1; a passing CI run → exits 0; a local run with verdict `fail` → exits 0.

- [ ] **Step 2: Implement, then update docs and version**

Implement `requestCiRunFailure` and wire it. In `package.json` set `"version": "0.1.0"` → `"0.2.0"`. In `README.md`: add `ai-qa run repair <run-id>` to the Usage section (one paragraph: what it repairs, that it is idempotent, where relocated data goes) and a short "Errors" paragraph documenting the envelope fields (`code`, `message`, `retryable`, `details`, `issues`). Mirror both edits into `README.zh-TW.md` and `README.zh-CN.md` (the three files' section structures are kept in sync).

- [ ] **Step 3: Full release gate**

Run: `pnpm check`
Expected: format, lint, typecheck, tests, and build all green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: single-run CI exit codes, repair docs, version 0.2.0"
```
