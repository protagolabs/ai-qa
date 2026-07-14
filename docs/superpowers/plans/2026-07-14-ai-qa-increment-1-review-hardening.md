# AI QA Increment 1 Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every Important and Minor finding from the Increment 1 code review so project-local state cannot escape its repository, terminal run/report integrity is exact, Web evidence has trustworthy provenance and timing, and concurrent or failed writes remain recoverable.

**Architecture:** Introduce shared project-storage and evidence-parity boundaries instead of repeating partial checks in individual services. Preserve the agent-orchestrates/CLI-owns-state model: typed services enforce the single Web controller, evidence lineage, verdict lifecycle, and report consistency while append-only domain semantics are retained through locked atomic JSONL rewrites. Apply every invariant both at mutation time and at later trust boundaries such as resume, finish, promotion, report generation, and export.

**Tech Stack:** Node.js 22 and 24, TypeScript strict mode, ESM, pnpm 11.9.0, Commander, Zod, YAML, proper-lockfile, Vitest, ESLint, and Prettier.

**Design Spec:** `docs/superpowers/specs/2026-07-13-ai-qa-design.md`

## Global Constraints

- Support Node.js 22 and Node.js 24 LTS; Node.js 20 is unsupported.
- Keep the package at private version `0.0.0`; npm publication remains outside Increment 1.
- Keep config, runs, cases, evidence, and reports inside the canonical target project's real `.ai-qa/` directory; reject symbolic-link ancestors and files.
- Keep repository trust only in machine-local `~/.ai-qa/trust.json`, overridden by `AI_QA_HOME` in tests.
- Use `chrome-devtools-mcp` as the only Increment 1 Web controller; the CLI does not call MCP itself.
- Preserve typed two-phase action write-back and immutable work orders, case revisions, and raw evidence.
- Require SHA-256 verification plus exact one-to-one evidence index/event parity at add, resume, finish, promotion, report generation, and export.
- A `cancelled` verdict is lifecycle-owned, always has empty criterion results, and cannot be authored through normal verdict set/revise commands.
- JSONL files are either empty or newline-terminated; committed updates use locked atomic replacement rather than direct append.
- All CLI failures emit one JSON error object without stack traces or raw filesystem exceptions.
- Follow TDD for every task and keep each task in a separate commit.

## File Map

```text
src/core/fs/project-storage.ts                 Shared canonical project-local directory/file checks
src/core/fs/json-lines.ts                      Strict JSONL reader and atomic serializer
src/core/tools.ts                              Canonical Web controller constant
src/core/evidence/parity.ts                    Exact evidence index/event parity validator
src/services/run-protocol/evidence-semantics.ts Post-action evidence freshness validator
src/core/config/repository.ts                  Safe create/read/replace config operations
src/core/runs/{journal,repository}.ts           Safe run paths and atomic journal persistence
src/core/cases/repository.ts                    Safe case storage ancestry
src/core/evidence/{schema,repository}.ts        Controller provenance and atomic index persistence
src/services/initialization/initialize-project.ts One-time, locked project initialization
src/services/run-protocol/*.ts                  Resume/finalize/tool/verdict integrity enforcement
src/services/case-promotion/draft-case.ts       Revalidation before promotion
src/services/report-generation/generate-run-report.ts Shared parity and report-set locking
src/services/trust/trust-store.ts               Lost-update-safe machine trust writes
src/cli/program.ts                              Last-resort structured error normalization
tests/unit/*.test.ts                            Storage and JSONL unit coverage
tests/integration/*.test.ts                     Protocol, concurrency, lifecycle, and report coverage
src/skills/global/references/web-work-protocol.md Agent-facing corrected protocol
docs/validation/web-live-acceptance.md           Manual regression checks
```

---

### Task 1: Canonical Project Storage and One-Time Initialization

**Files:**
- Create: `src/core/fs/project-storage.ts`
- Create: `tests/unit/project-storage.test.ts`
- Modify: `src/core/config/repository.ts:1-27`
- Modify: `src/services/initialization/initialize-project.ts:1-37`
- Modify: `src/core/runs/journal.ts:32-170`
- Modify: `src/core/runs/repository.ts:45-150`
- Modify: `src/core/cases/repository.ts:30-390`
- Modify: `tests/integration/init.test.ts:43-157`
- Modify: `tests/integration/run-hardening.test.ts:108-137`
- Modify: `tests/integration/case-promotion.test.ts:387-551`

**Interfaces:**
- Consumes: Existing `AiQaError`, `atomicWriteFile`, `proper-lockfile`, project-root canonicalization, and repository-specific schemas.
- Produces: `ensureProjectLocalDirectory(projectRoot, segments): Promise<string>`, `requireProjectLocalDirectory(projectRoot, segments): Promise<string>`, `requireProjectLocalRegularFile(projectRoot, segments): Promise<string>`, and `createProjectConfig(projectRoot, config): Promise<void>`.

- [ ] **Step 1: Write failing canonical-storage tests**

Create `tests/unit/project-storage.test.ts`:

```ts
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../../src/core/fs/project-storage.js";

describe("project-local storage", () => {
  it("rejects a symlinked .ai-qa ancestor before creating descendants", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    const outside = await mkdtemp(join(tmpdir(), "ai-qa-storage-outside-"));
    await symlink(outside, join(projectRoot, ".ai-qa"));

    await expect(
      ensureProjectLocalDirectory(projectRoot, [".ai-qa", "runs"]),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });

  it("rejects a symlinked file even when it resolves inside the project", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-storage-project-"));
    await mkdir(join(projectRoot, ".ai-qa"));
    await writeFile(join(projectRoot, "real.yaml"), "schemaVersion: 1\n");
    await symlink(
      join(projectRoot, "real.yaml"),
      join(projectRoot, ".ai-qa", "config.yaml"),
    );

    await expect(
      requireProjectLocalRegularFile(projectRoot, [
        ".ai-qa",
        "config.yaml",
      ]),
    ).rejects.toMatchObject({ code: "storage.integrity_error" });
  });
});
```

Add these cases to `tests/integration/init.test.ts`:

```ts
it("never follows a symlinked .ai-qa directory", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-project-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-qa-init-outside-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-init-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: new Date("2026-07-13T00:00:00.000Z"),
  });
  await symlink(outside, join(projectRoot, ".ai-qa"));

  await expect(
    initializeProject({ projectRoot, aiQaHome, config: confirmedConfig }),
  ).rejects.toMatchObject({ code: "storage.integrity_error" });
  await expect(access(join(outside, "config.yaml"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses reinitialization and preserves the original project id", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-init-project-"));
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-init-home-"));
  await confirmProjectTrust({
    projectRoot,
    aiQaHome,
    confirmed: true,
    now: new Date("2026-07-13T00:00:00.000Z"),
  });
  await initializeProject({ projectRoot, aiQaHome, config: confirmedConfig });

  await expect(
    initializeProject({
      projectRoot,
      aiQaHome,
      config: {
        ...confirmedConfig,
        project: { id: "replacement-id", name: "Replacement" },
      },
    }),
  ).rejects.toMatchObject({ code: "project.already_initialized" });
  await expect(readProjectConfig(projectRoot)).resolves.toMatchObject({
    project: { id: "sample-web" },
  });
});
```

- [ ] **Step 2: Run the storage tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/project-storage.test.ts tests/integration/init.test.ts
```

Expected: FAIL because `project-storage.ts` does not exist, and current initialization follows `.ai-qa` and overwrites an existing config.

- [ ] **Step 3: Implement the shared storage boundary**

Create `src/core/fs/project-storage.ts`:

```ts
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AiQaError } from "../errors.js";

function validateSegments(segments: readonly string[]): void {
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment.includes("/") ||
        segment.includes("\\"),
    )
  ) {
    throw storageError("Project-local storage segments are invalid");
  }
}

async function walkDirectories(
  projectRoot: string,
  segments: readonly string[],
  create: boolean,
): Promise<string> {
  validateSegments(segments);
  let current = await realpath(projectRoot);
  for (const segment of segments) {
    current = resolve(current, segment);
    if (create) {
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (error: unknown) {
        if (!isNodeError(error, "EEXIST")) throw error;
      }
    }
    try {
      const stats = await lstat(current);
      if (
        stats.isSymbolicLink() ||
        !stats.isDirectory() ||
        (await realpath(current)) !== current
      ) {
        throw storageError("Project-local storage ancestor is not a real directory", current);
      }
    } catch (error: unknown) {
      if (error instanceof AiQaError) throw error;
      throw storageError(
        "Project-local storage directory verification failed",
        current,
        nodeErrorCode(error),
      );
    }
  }
  return current;
}

export function ensureProjectLocalDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return walkDirectories(projectRoot, segments, true);
}

export function requireProjectLocalDirectory(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  return walkDirectories(projectRoot, segments, false);
}

export async function requireProjectLocalRegularFile(
  projectRoot: string,
  segments: readonly string[],
): Promise<string> {
  validateSegments(segments);
  const parent = await requireProjectLocalDirectory(
    projectRoot,
    segments.slice(0, -1),
  );
  const path = resolve(parent, segments.at(-1)!);
  try {
    const stats = await lstat(path);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (await realpath(path)) !== path
    ) {
      throw storageError("Project-local artifact is not a real regular file", path);
    }
    return path;
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    throw storageError(
      "Project-local artifact verification failed",
      path,
      nodeErrorCode(error),
    );
  }
}

function storageError(
  message: string,
  path?: string,
  causeCode?: string,
): AiQaError {
  return new AiQaError(
    "storage.integrity_error",
    message,
    {
      ...(path === undefined ? {} : { path }),
      ...(causeCode === undefined ? {} : { causeCode }),
    },
  );
}

function nodeErrorCode(error: unknown): string | undefined {
  return error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
```

- [ ] **Step 4: Split config creation from config replacement**

Replace `src/core/config/repository.ts` with safe create/read/write operations:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile } from "../fs/atomic-write.js";
import {
  requireProjectLocalDirectory,
  requireProjectLocalRegularFile,
} from "../fs/project-storage.js";
import { projectConfigSchema, type ProjectConfig } from "./schema.js";

function serialize(config: ProjectConfig): string {
  return stringify(projectConfigSchema.parse(config), { sortMapEntries: true });
}

export async function createProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const directory = await requireProjectLocalDirectory(projectRoot, [".ai-qa"]);
  await atomicWriteFile(resolve(directory, "config.yaml"), serialize(config));
}

export async function readProjectConfig(
  projectRoot: string,
): Promise<ProjectConfig> {
  const path = await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "config.yaml",
  ]);
  return projectConfigSchema.parse(parse(await readFile(path, "utf8")));
}

export async function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): Promise<void> {
  const path = await requireProjectLocalRegularFile(projectRoot, [
    ".ai-qa",
    "config.yaml",
  ]);
  await atomicWriteFile(path, serialize(config));
}
```

- [ ] **Step 5: Make initialization one-time and lock its decision**

Update `initializeProject()` to create and lock the real `.ai-qa` directory before checking config existence:

```ts
const aiQaRoot = await ensureProjectLocalDirectory(input.projectRoot, [".ai-qa"]);
const release = await lockfile.lock(aiQaRoot, {
  realpath: false,
  retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
});
try {
  try {
    await lstat(resolve(aiQaRoot, "config.yaml"));
    throw new AiQaError(
      "project.already_initialized",
      "Project already has an AI QA configuration",
      { projectRoot: identity.canonicalPath },
    );
  } catch (error: unknown) {
    if (error instanceof AiQaError) throw error;
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  for (const segments of [
    [".ai-qa", "cases"],
    [".ai-qa", "runs"],
    [".ai-qa", "evidence"],
    [".ai-qa", "reports", "runs"],
  ] as const) {
    await ensureProjectLocalDirectory(input.projectRoot, segments);
  }
  await createProjectConfig(input.projectRoot, config);
} finally {
  await release();
}
```

Import `lstat`, `resolve`, `proper-lockfile`, `createProjectConfig`, and `ensureProjectLocalDirectory`; remove recursive `mkdir` and `writeProjectConfig`. Keep schema and trust checks before creating `.ai-qa`.

- [ ] **Step 6: Apply the boundary to runs and cases**

Before run creation, require the real runs root:

```ts
await ensureProjectLocalDirectory(this.projectRoot, [".ai-qa", "runs"]);
```

Before reading a work order, require the exact regular file:

```ts
const workOrderPath = await requireProjectLocalRegularFile(this.projectRoot, [
  ".ai-qa",
  "runs",
  runId,
  "work-order.json",
]);
const raw: unknown = JSON.parse(await readFile(workOrderPath, "utf8"));
```

Store `projectRoot` on `RunJournal`; before every `readLocked()` and `appendPrepared()` lock acquisition, call:

```ts
await requireProjectLocalRegularFile(this.projectRoot, [
  ".ai-qa",
  "runs",
  this.runId,
  "events.jsonl",
]);
```

In `CaseRepository.createDraft()`, replace recursive `mkdir(paths.revisions)` with:

```ts
await ensureProjectLocalDirectory(this.projectRoot, [
  ".ai-qa",
  "cases",
  caseId,
  "revisions",
]);
```

Before reading `case.yaml` or a revision YAML, resolve the exact regular file and then parse that returned path:

```ts
const indexPath = await requireProjectLocalRegularFile(this.projectRoot, [
  ".ai-qa",
  "cases",
  caseId,
  "case.yaml",
]);
const revisionPath = await requireProjectLocalRegularFile(this.projectRoot, [
  ".ai-qa",
  "cases",
  caseId,
  "revisions",
  `${String(revision)}.yaml`,
]);
```

Use `indexPath` in `readIndex()` and `revisionPath` in `readRevision()`; exclusive file creation and the existing directory/index locks execute only after the ancestor check.

- [ ] **Step 7: Add run/case symlink regression tests**

Add to `tests/integration/run-hardening.test.ts`:

```ts
it("rejects a symlinked runs root before creating a run outside the project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-runs-project-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-qa-runs-outside-"));
  await mkdir(join(projectRoot, ".ai-qa"));
  await symlink(outside, join(projectRoot, ".ai-qa", "runs"));

  await expect(createRepositoryRun(projectRoot)).rejects.toMatchObject({
    code: "storage.integrity_error",
  });
  await expect(access(join(outside, "run-1"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
```

Add to `tests/integration/case-promotion.test.ts`:

```ts
it("rejects a symlinked cases root before creating a draft outside the project", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "ai-qa-cases-project-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-qa-cases-outside-"));
  await mkdir(join(projectRoot, ".ai-qa"));
  await symlink(outside, join(projectRoot, ".ai-qa", "cases"));

  await expect(
    new CaseRepository(projectRoot, runNow).createDraft({
      schemaVersion: 1,
      caseId: "login-success",
      title: "Login succeeds",
      promotion: {
        sourceRunId: "run-source",
        excludedActions: [],
        validationIssues: [],
      },
      acceptanceCriteria: [
        {
          id: "authenticated-home-visible",
          description: "Authenticated home is visible",
          requiredEvidence: ["post-action-screenshot"],
        },
      ],
      variants: {
        web: {
          steps: [
            {
              id: "step-submit-login",
              sourceActionId: "event-submit-login",
              intent: "Submit valid credentials",
              tool: "chrome-devtools-mcp",
              target: {
                description: "Login button",
                stability: "stable",
                stabilityRationale: "Stable test id",
              },
              expectedState: "Authenticated home is visible",
              assertionStrategy: "Observe authenticated shell",
              evidenceCheckpoints: ["post-action-screenshot"],
            },
          ],
        },
      },
    }),
  ).rejects.toMatchObject({ code: "storage.integrity_error" });
  await expect(access(join(outside, "login-success"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
```

- [ ] **Step 8: Run the focused and full tests**

Run:

```bash
pnpm vitest run tests/unit/project-storage.test.ts tests/integration/init.test.ts tests/integration/run-hardening.test.ts tests/integration/case-promotion.test.ts
pnpm typecheck
```

Expected: PASS; no test writes through a symlink, repeated init preserves the original config, and TypeScript reports zero errors.

- [ ] **Step 9: Commit**

```bash
git add src/core/fs/project-storage.ts src/core/config/repository.ts src/services/initialization/initialize-project.ts src/core/runs/journal.ts src/core/runs/repository.ts src/core/cases/repository.ts tests/unit/project-storage.test.ts tests/integration/init.test.ts tests/integration/run-hardening.test.ts tests/integration/case-promotion.test.ts
git commit -m "fix: confine project state to canonical storage"
```

---

### Task 2: Crash-Safe JSONL and Concurrent Trust Updates

**Files:**
- Modify: `src/core/fs/json-lines.ts:1-13`
- Modify: `src/core/runs/journal.ts:1-170`
- Modify: `src/core/evidence/repository.ts:119-214`
- Modify: `src/services/trust/trust-store.ts:1-64`
- Modify: `tests/unit/fs-integrity.test.ts:1-35`
- Modify: `tests/integration/run-journal.test.ts:1-180`
- Modify: `tests/integration/evidence.test.ts:147-430`
- Modify: `tests/integration/init.test.ts:200-268`

**Interfaces:**
- Consumes: Task 1 canonical storage checks, `atomicWriteFile()`, existing journal/evidence locks, and trust schemas.
- Produces: `serializeJsonLines(records): string` and `writeJsonLines(path, records): Promise<void>`; all committed journal/index writes become atomic, newline-terminated replacements.

- [ ] **Step 1: Write failing JSONL and trust-concurrency tests**

Add to `tests/unit/fs-integrity.test.ts`:

```ts
it("rejects a non-empty JSONL file without a final newline", async () => {
  const root = await mkdtemp(join(tmpdir(), "ai-qa-jsonl-tail-"));
  const path = join(root, "records.jsonl");
  await writeFile(path, '{"id":1}');

  await expect(
    readJsonLines(path, z.object({ id: z.number().int() })),
  ).rejects.toThrow("newline-terminated");
});
```

Add to the machine-trust section in `tests/integration/init.test.ts`:

```ts
it("preserves every concurrent trust confirmation", async () => {
  const aiQaHome = await mkdtemp(join(tmpdir(), "ai-qa-trust-home-"));
  const roots = await Promise.all(
    Array.from({ length: 20 }, () =>
      mkdtemp(join(tmpdir(), "ai-qa-trust-project-")),
    ),
  );
  const identities = await Promise.all(roots.map(readRepositoryIdentity));
  const store = new TrustStore(aiQaHome);

  await Promise.all(
    identities.map((identity) =>
      store.trust(identity, new Date("2026-07-13T00:00:00.000Z")),
    ),
  );

  await expect(
    Promise.all(identities.map((identity) => store.isTrusted(identity))),
  ).resolves.toEqual(Array.from({ length: 20 }, () => true));
});
```

- [ ] **Step 2: Run tests and verify the old behavior fails**

Run:

```bash
pnpm vitest run tests/unit/fs-integrity.test.ts tests/integration/init.test.ts
```

Expected: FAIL because `readJsonLines()` accepts an unterminated tail and concurrent trust read-modify-write calls lose entries.

- [ ] **Step 3: Add strict JSONL serialization**

Update `src/core/fs/json-lines.ts`:

```ts
import { readFile } from "node:fs/promises";
import type { z } from "zod";
import { atomicWriteFile } from "./atomic-write.js";

export function serializeJsonLines(records: readonly unknown[]): string {
  return records.length === 0
    ? ""
    : `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export function writeJsonLines(
  path: string,
  records: readonly unknown[],
): Promise<void> {
  return atomicWriteFile(path, serializeJsonLines(records));
}

export async function readJsonLines<T>(
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const content = await readFile(path, "utf8");
  if (content.length === 0) return [];
  if (!content.endsWith("\n")) {
    throw new Error("Non-empty JSONL files must be newline-terminated");
  }
  return content
    .slice(0, -1)
    .split("\n")
    .map((line) => schema.parse(JSON.parse(line)));
}
```

- [ ] **Step 4: Replace direct journal and evidence appends atomically**

In `RunJournal.appendToSnapshot()`, replace `open(path, "a")` with:

```ts
const nextEvents = [...events, event];
await writeJsonLines(this.path, nextEvents);
events.push(event);
return event;
```

Keep the journal lock around the read, event construction, atomic replacement, and in-memory update.

In `EvidenceRepository.registerRaw()`, replace the direct index append with:

```ts
await writeJsonLines(this.paths.index, [...records, record]);
ownsCopiedPath = false;
return record;
```

Remove `appendStarted`. In the catch block, delete `copiedPath` whenever `ownsCopiedPath` remains true, because a failed atomic replacement leaves the previous index intact.

- [ ] **Step 5: Serialize trust read-modify-write under a machine-home lock**

Update `TrustStore.trust()`:

```ts
async trust(identity: RepositoryIdentity, confirmedAt: Date): Promise<void> {
  await mkdir(this.aiQaHome, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(this.aiQaHome, {
    realpath: false,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    const current = await this.read();
    const entry = {
      canonicalPath: identity.canonicalPath,
      fingerprint: identity.fingerprint,
      confirmedAt: confirmedAt.toISOString(),
    };
    const entries = current.entries.filter(
      (value) => value.canonicalPath !== identity.canonicalPath,
    );
    await atomicWriteFile(
      this.path,
      `${JSON.stringify(
        { schemaVersion: 1, entries: [...entries, entry] },
        null,
        2,
      )}\n`,
    );
  } finally {
    await release();
  }
}
```

Import `mkdir` and `proper-lockfile`. `isTrusted()` remains a read-only atomic-file read.

- [ ] **Step 6: Add persistence regression checks**

In `tests/integration/run-journal.test.ts`, append two events, read `events.jsonl`, and assert it ends with exactly one newline and parses through `RunJournal.readAll()`. In `tests/integration/evidence.test.ts`, register two records and assert `index.jsonl` ends with a newline and both records survive a new `EvidenceRepository` instance.

```ts
expect(await readFile(path, "utf8")).toMatch(/\n$/u);
await expect(reopened.readAll()).resolves.toHaveLength(2);
```

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
pnpm vitest run tests/unit/fs-integrity.test.ts tests/integration/run-journal.test.ts tests/integration/evidence.test.ts tests/integration/init.test.ts
pnpm typecheck
```

Expected: PASS; JSONL tails are strict, journal/index replacements are atomic under their existing locks, and all concurrent trust entries remain present.

```bash
git add src/core/fs/json-lines.ts src/core/runs/journal.ts src/core/evidence/repository.ts src/services/trust/trust-store.ts tests/unit/fs-integrity.test.ts tests/integration/run-journal.test.ts tests/integration/evidence.test.ts tests/integration/init.test.ts
git commit -m "fix: make journals and trust updates crash safe"
```

---

### Task 3: Shared Exact Evidence Parity at Every Trust Boundary

**Files:**
- Create: `src/core/evidence/parity.ts`
- Create: `tests/unit/evidence-parity.test.ts`
- Modify: `src/services/run-protocol/register-evidence.ts:38-126`
- Modify: `src/services/run-protocol/finalize-run.ts:104-140`
- Modify: `src/services/run-protocol/run-lifecycle.ts:25-84`
- Modify: `src/services/case-promotion/draft-case.ts:230-320`
- Modify: `src/services/report-generation/generate-run-report.ts:160-230, 500-540`
- Modify: `tests/integration/evidence.test.ts:566-1062`
- Modify: `tests/integration/run-finalize.test.ts:191-508, 647-722`
- Modify: `tests/integration/case-promotion.test.ts:552-748`
- Modify: `tests/integration/report-generation.test.ts:371-438`

**Interfaces:**
- Consumes: `RunEvent`, `EvidenceRecord`, `evidenceEventPayloadSchema`, `evidenceRecordSchema`, and `canonicalJson()`.
- Produces: `validateEvidenceParity(events, records, runId): void`; callers receive `evidence.integrity_error` for duplicates, omissions, or mismatches.

- [ ] **Step 1: Add failing finish and resume parity tests**

In `tests/integration/run-finalize.test.ts`, use `createRun()` and `recordSupportedCriterion()` to create valid evidence, then duplicate its exact index line before setting a supported verdict:

```ts
it("rejects duplicate evidence index records before finish", async () => {
  const fixture = await createRun();
  const support = await recordSupportedCriterion(fixture);
  const indexPath = join(
    fixture.projectRoot,
    ".ai-qa",
    "evidence",
    "run-1",
    "index.jsonl",
  );
  const index = await readFile(indexPath, "utf8");
  await writeFile(indexPath, `${index}${index}`);
  await fixture.verdicts.set({
    classification: "pass",
    summary: "Login verified",
    criterionResults: [
      {
        criterionId: "authenticated-home-visible",
        status: "satisfied",
        assertionIds: [support.assertion.id],
        evidenceIds: [support.evidence.id],
      },
    ],
  });

  await expect(
    finalizeRun({
      projectRoot: fixture.projectRoot,
      aiQaHome: fixture.aiQaHome,
      runId: "run-1",
      now,
    }),
  ).rejects.toMatchObject({ code: "evidence.integrity_error" });
});
```

Add the same duplicated-index setup to the resume test and assert `resumeRun()` rejects `evidence.integrity_error` without appending interrupted/resumed lifecycle events.

- [ ] **Step 2: Run the parity tests and verify finish currently succeeds**

Run:

```bash
pnpm vitest run tests/integration/run-finalize.test.ts -t "duplicate evidence|resume"
```

Expected: FAIL because `verifyAll()` hashes duplicate records independently and does not compare index cardinality to typed evidence events.

- [ ] **Step 3: Implement the shared parity validator**

Create `src/core/evidence/parity.ts`:

```ts
import { canonicalJson } from "../canonical-json.js";
import { AiQaError } from "../errors.js";
import { evidenceEventPayloadSchema } from "../runs/event-payloads.js";
import type { RunEvent } from "../runs/schema.js";
import { evidenceRecordSchema, type EvidenceRecord } from "./schema.js";

export function validateEvidenceParity(
  events: readonly RunEvent[],
  records: readonly EvidenceRecord[],
  runId: string,
): void {
  try {
    const indexed = new Map(records.map((record) => [record.id, record]));
    if (indexed.size !== records.length) throw new Error("duplicate index record");

    const eventRecords = new Map<string, EvidenceRecord>();
    for (const event of events) {
      if (event.type !== "evidence") continue;
      const payload = evidenceEventPayloadSchema.parse(event.payload);
      const { criterionIds, observationIds, ...recordInput } = payload;
      void criterionIds;
      void observationIds;
      const record = evidenceRecordSchema.parse(recordInput);
      if (eventRecords.has(record.id)) throw new Error("duplicate event record");
      eventRecords.set(record.id, record);
    }

    if (indexed.size !== eventRecords.size) throw new Error("count mismatch");
    for (const [id, record] of indexed) {
      const fromEvent = eventRecords.get(id);
      if (
        record.runId !== runId ||
        fromEvent === undefined ||
        canonicalJson(record) !== canonicalJson(fromEvent)
      ) {
        throw new Error("record mismatch");
      }
    }
  } catch {
    throw new AiQaError(
      "evidence.integrity_error",
      "Evidence index does not exactly match typed run evidence events",
      { runId },
    );
  }
}
```

- [ ] **Step 4: Invoke parity after evidence add and at every later boundary**

After `registerEvidence()` completes its journal append, reacquire the journal read lock and verify the persisted pair before returning:

```ts
const record = await journal.appendPrepared(/* existing prepared append */);
await journal.readLocked(async (events) => {
  const records = await new EvidenceRepository(
    trusted.projectRoot,
    input.runId,
    input.now,
  ).verifyAll();
  validateEvidenceParity(events, records, input.runId);
});
return record;
```

Immediately after each `verifyAll()` call in `finalizeRun()` and `resumeRun()`:

```ts
validateEvidenceParity(events, evidence, runId);
```

In case promotion, replace the local map/cardinality implementation in `readVerifiedEvidence()` with `validateEvidenceParity(events, evidence, runId)`. Preserve the current `valid: false` conversion so an invalid source produces an inactive draft rather than trusted evidence.

In report generation, import the shared function and delete the private duplicate implementation. Both generate and export already pass through `buildVerifiedRunReport()`, so that single call covers both operations.

- [ ] **Step 5: Add orphan-index and orphan-event coverage**

Create `tests/unit/evidence-parity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { validateEvidenceParity } from "../../src/core/evidence/parity.js";
import { evidenceRecordSchema } from "../../src/core/evidence/schema.js";
import { runEventSchema } from "../../src/core/runs/schema.js";

const record = evidenceRecordSchema.parse({
  schemaVersion: 1,
  id: "evidence-proof",
  runId: "run-1",
  projectRelativePath: ".ai-qa/evidence/run-1/files/evidence-proof-screen.png",
  contentHash: `sha256:${"0".repeat(64)}`,
  mediaType: "image/png",
  platform: "web",
  sourceTool: "chrome-devtools-mcp",
  capturedAt: "2026-07-13T00:00:00.000Z",
  classification: "raw",
  sensitivity: "internal",
  evidenceKinds: ["post-action-screenshot"],
  captureActionId: "event-capture",
  idempotencyKey: "capture-proof",
});

const event = runEventSchema.parse({
  schemaVersion: 1,
  id: "event-evidence-proof",
  runId: "run-1",
  sequence: 1,
  timestamp: "2026-07-13T00:00:00.000Z",
  actor: "ai-qa",
  platform: "web",
  tool: "ai-qa",
  type: "evidence",
  idempotencyKey: "capture-proof",
  payload: {
    ...record,
    criterionIds: ["criterion-proof"],
    observationIds: ["event-observation"],
  },
  relatedIds: ["event-capture", "event-observation"],
});

describe("validateEvidenceParity", () => {
  it("rejects an index record without its typed event", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([], [record], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
  });

  it("rejects a typed event without its index record", () => {
    let thrown: unknown;
    try {
      validateEvidenceParity([event], [], "run-1");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: "evidence.integrity_error" });
  });
});
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm vitest run tests/unit/evidence-parity.test.ts tests/integration/evidence.test.ts tests/integration/run-finalize.test.ts tests/integration/case-promotion.test.ts tests/integration/report-generation.test.ts
pnpm typecheck
```

Expected: PASS; duplicates and one-sided records fail uniformly at add, resume, finish, promotion, generation, and export.

```bash
git add src/core/evidence/parity.ts src/services/run-protocol/register-evidence.ts src/services/run-protocol/finalize-run.ts src/services/run-protocol/run-lifecycle.ts src/services/case-promotion/draft-case.ts src/services/report-generation/generate-run-report.ts tests/unit/evidence-parity.test.ts tests/integration/evidence.test.ts tests/integration/run-finalize.test.ts tests/integration/case-promotion.test.ts tests/integration/report-generation.test.ts
git commit -m "fix: enforce exact evidence event parity"
```

---

### Task 4: Pin Web Controller Provenance End to End

**Files:**
- Create: `src/core/tools.ts`
- Modify: `src/core/config/schema.ts:1-20`
- Modify: `src/core/evidence/schema.ts:1-65`
- Modify: `src/core/evidence/repository.ts:23-44, 174-191`
- Modify: `src/core/runs/schema.ts:74-94`
- Modify: `src/core/cases/schema.ts:22-40`
- Modify: `src/services/run-protocol/run-protocol-service.ts:1-220, 723-900`
- Modify: `src/services/run-protocol/register-evidence.ts:221-260`
- Modify: `src/services/case-promotion/draft-case.ts:105-142`
- Modify: `tests/integration/typed-protocol.test.ts`
- Modify: `tests/integration/evidence.test.ts`
- Modify: `tests/integration/case-promotion.test.ts`

**Interfaces:**
- Consumes: Existing Web-only schemas and typed protocol validation.
- Produces: `WEB_CONTROLLER` and `webControllerSchema`; every Web action, evidence record, required step, and case step uses the same literal controller.

- [ ] **Step 1: Write failing fake-controller tests**

Add to `tests/integration/typed-protocol.test.ts`:

```ts
it("rejects an exploratory action from an unconfigured controller", async () => {
  expect(
    planActionInputSchema.safeParse({
      idempotencyKey: "fake-controller",
      kind: "interaction",
      intent: "Click with an unconfigured tool",
      tool: "fake-browser",
      target: { description: "Login button" },
    }).success,
  ).toBe(false);
});
```

Add to `tests/integration/evidence.test.ts`:

```ts
expect(
  registerRawEvidenceInputSchema.safeParse({
    sourcePath: "/tmp/screen.png",
    mediaType: "image/png",
    sourceTool: "fake-browser",
    sensitivity: "internal",
    evidenceKinds: ["post-action-screenshot"],
    captureActionId: "event-capture",
    idempotencyKey: "fake-source",
  }).success,
).toBe(false);
```

In case promotion, append a schema-valid planned event whose event-level `tool` is `fake-browser`, followed by its terminal write-back, then assert `draftCaseFromRun()` rejects `run_protocol.integrity_error` instead of emitting a Chrome case step.

- [ ] **Step 2: Run tests and verify arbitrary tools are accepted**

Run:

```bash
pnpm vitest run tests/integration/typed-protocol.test.ts tests/integration/evidence.test.ts tests/integration/case-promotion.test.ts -t "controller|source tool"
```

Expected: FAIL because planned action and evidence schemas currently accept any non-empty tool string.

- [ ] **Step 3: Define and use one controller schema**

Create `src/core/tools.ts`:

```ts
import { z } from "zod";

export const WEB_CONTROLLER = "chrome-devtools-mcp" as const;
export const webControllerSchema = z.literal(WEB_CONTROLLER);
export type WebController = z.infer<typeof webControllerSchema>;
```

Replace each duplicated Chrome literal schema in config, required steps, case steps, evidence records, and raw evidence input with `webControllerSchema`. In `planActionInputSchema`, change `tool` to `webControllerSchema`.

- [ ] **Step 4: Revalidate forged journals and evidence provenance**

In the planned-action branch of `validateProtocolEvents()` require:

```ts
requireSemantic(event.tool === WEB_CONTROLLER);
```

In the evidence branch require the evidence source to match its capture action:

```ts
requireSemantic(payload.sourceTool === WEB_CONTROLLER);
requireSemantic(payload.sourceTool === plan?.event.tool);
```

In `requireCompletedCaptureAction()`, return the planned capture instead of `void`:

```ts
function requireCompletedCaptureAction(
  events: readonly RunEvent[],
  captureActionId: string,
): { event: RunEvent; payload: Extract<ActionPayload, { phase: "planned" }> } {
  const actions = events
    .filter((event) => event.type === "action")
    .map((event) => ({
      event,
      payload: actionPayloadSchema.parse(event.payload),
    }));
  const planned = actions.find(
    ({ event, payload }) =>
      event.id === captureActionId &&
      payload.phase === "planned" &&
      payload.kind === "evidence-capture",
  );
  if (planned === undefined || planned.payload.phase !== "planned") {
    throw invalidCaptureAction(captureActionId);
  }
  const terminals = actions.filter(
    ({ payload }) =>
      payload.phase !== "planned" && payload.actionId === captureActionId,
  );
  if (terminals.length !== 1 || terminals[0]?.payload.phase !== "completed") {
    throw invalidCaptureAction(captureActionId);
  }
  if (planned.event.tool !== WEB_CONTROLLER) {
    throw invalidCaptureAction(captureActionId);
  }
  return planned;
}
```

At registration, compare before copying:

```ts
const capture = requireCompletedCaptureAction(events, payload.captureActionId);
if (payload.sourceTool !== capture.event.tool) {
  throw new AiQaError(
    "evidence.source_tool_mismatch",
    "Evidence source tool must match its completed capture action",
    { captureActionId: payload.captureActionId },
  );
}
```

Case promotion may continue emitting `WEB_CONTROLLER`, but only after `validateProtocolEvents()` has established that every source action used by a proposed step has that exact provenance.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
pnpm vitest run tests/integration/typed-protocol.test.ts tests/integration/evidence.test.ts tests/integration/case-promotion.test.ts tests/integration/regression-replay.test.ts
pnpm typecheck
```

Expected: PASS; arbitrary controller names fail both live mutation and forged-history validation.

```bash
git add src/core/tools.ts src/core/config/schema.ts src/core/evidence/schema.ts src/core/evidence/repository.ts src/core/runs/schema.ts src/core/cases/schema.ts src/services/run-protocol/run-protocol-service.ts src/services/run-protocol/register-evidence.ts src/services/case-promotion/draft-case.ts tests/integration/typed-protocol.test.ts tests/integration/evidence.test.ts tests/integration/case-promotion.test.ts tests/integration/regression-replay.test.ts
git commit -m "fix: pin web evidence to the configured controller"
```

---

### Task 5: Reject Pre-Action Evidence Laundering

**Files:**
- Create: `src/services/run-protocol/evidence-semantics.ts`
- Create: `tests/unit/evidence-semantics.test.ts`
- Modify: `src/services/run-protocol/finalize-run.ts:235-289`
- Modify: `src/services/case-promotion/draft-case.ts:230-320`
- Modify: `tests/integration/run-finalize.test.ts:191-508`
- Modify: `tests/integration/case-promotion.test.ts:631-748`
- Modify: `tests/integration/report-generation.test.ts:439-514`

**Interfaces:**
- Consumes: Typed action, observation, assertion, evidence events and the effective `VerdictPayload`.
- Produces: `validatePassEvidenceFreshness(events, verdict): void`, which ensures post-action screenshots and cited observations belong to the asserted step and postdate the latest relevant completed interaction.

- [ ] **Step 1: Write the failing laundering test**

In `tests/integration/run-finalize.test.ts`, create this timeline: observe initial state, capture evidence labeled `post-action-screenshot`, perform and complete an interaction, then create a satisfied assertion for the interaction step citing the old observation/evidence. Set a pass verdict and assert:

```ts
await expect(
  finalizeRun({
    projectRoot: fixture.projectRoot,
    aiQaHome: fixture.aiQaHome,
    runId: "run-1",
    now,
  }),
).rejects.toMatchObject({ code: "verdict.stale_post_action_evidence" });
```

The assertion must use the interaction's `stepId`; the old observation and capture retain their original earlier step ID. Keep all IDs schema-valid so the test reaches the freshness invariant.

- [ ] **Step 2: Run the test and confirm current finalization accepts it**

Run:

```bash
pnpm vitest run tests/integration/run-finalize.test.ts -t "pre-action evidence"
```

Expected: FAIL because the run currently completes as `pass`.

- [ ] **Step 3: Implement evidence freshness validation**

Create `src/services/run-protocol/evidence-semantics.ts`:

```ts
import { AiQaError } from "../../core/errors.js";
import {
  actionPayloadSchema,
  assertionPayloadSchema,
  evidenceEventPayloadSchema,
  observationPayloadSchema,
} from "../../core/runs/event-payloads.js";
import type { RunEvent } from "../../core/runs/schema.js";
import type { VerdictPayload } from "../../core/verdicts/schema.js";

export function validatePassEvidenceFreshness(
  events: readonly RunEvent[],
  verdict: VerdictPayload,
): void {
  if (verdict.classification !== "pass") return;
  const byId = new Map(events.map((event) => [event.id, event]));
  const plans = new Map(
    events.flatMap((event) => {
      if (event.type !== "action") return [];
      const payload = actionPayloadSchema.parse(event.payload);
      return payload.phase === "planned" ? [[event.id, { event, payload }] as const] : [];
    }),
  );
  const completedInteractions = events.flatMap((event) => {
    if (event.type !== "action") return [];
    const payload = actionPayloadSchema.parse(event.payload);
    if (payload.phase !== "completed") return [];
    const plan = plans.get(payload.actionId);
    return plan?.payload.kind === "interaction" ? [{ event, plan }] : [];
  });

  for (const result of verdict.criterionResults) {
    for (const assertionId of result.assertionIds) {
      const assertionEvent = byId.get(assertionId);
      if (assertionEvent?.type !== "assertion") continue;
      const assertion = assertionPayloadSchema.parse(assertionEvent.payload);
      const latestInteraction = completedInteractions
        .filter(({ event }) => event.sequence < assertionEvent.sequence)
        .at(-1);

      for (const evidenceId of result.evidenceIds) {
        const evidenceEvent = events.find(
          (event) =>
            event.type === "evidence" &&
            evidenceEventPayloadSchema.safeParse(event.payload).data?.id === evidenceId,
        );
        if (evidenceEvent === undefined) continue;
        const evidence = evidenceEventPayloadSchema.parse(evidenceEvent.payload);
        if (!evidence.evidenceKinds.includes("post-action-screenshot")) continue;
        const capture = plans.get(evidence.captureActionId);
        const observations = evidence.observationIds.map((id) => {
          const event = byId.get(id);
          return event?.type === "observation"
            ? { event, payload: observationPayloadSchema.parse(event.payload) }
            : undefined;
        });
        const invalid =
          assertion.stepId === undefined ||
          capture?.payload.stepId !== assertion.stepId ||
          observations.length === 0 ||
          observations.some(
            (entry) =>
              entry === undefined ||
              entry.payload.stepId !== assertion.stepId ||
              entry.event.sequence >= evidenceEvent.sequence,
          ) ||
          (latestInteraction !== undefined &&
            (latestInteraction.plan.payload.stepId !== assertion.stepId ||
              evidenceEvent.sequence <= latestInteraction.event.sequence ||
              observations.some(
                (entry) =>
                  entry !== undefined &&
                  entry.event.sequence <= latestInteraction.event.sequence,
              )));
        if (invalid) {
          throw new AiQaError(
            "verdict.stale_post_action_evidence",
            "Post-action evidence must be captured from fresh observations for the asserted step",
            { assertionId, evidenceId },
          );
        }
      }
    }
  }
}
```

- [ ] **Step 4: Enforce freshness during finish and later revalidation**

In `validateFinalization()`, after `validateVerdictCitations()` and before the classification switch:

```ts
validatePassEvidenceFreshness(input.events, input.verdict.payload);
```

Report generation already reapplies `validateFinalization()` for completed runs. In case promotion, after `readVerifiedEvidence()` succeeds, reapply the same finalization boundary:

```ts
let evidenceValid = evidenceResult.valid;
if (evidenceValid) {
  try {
    validateFinalization({
      workOrder,
      events,
      evidence: evidenceResult.evidence,
      verdict: effective,
      completionTime: new Date(lifecycle.current.event.timestamp),
    });
  } catch (error: unknown) {
    if (!(error instanceof AiQaError)) throw error;
    evidenceValid = false;
  }
}
return {
  workOrder,
  events,
  verdict: effective.payload,
  evidence: evidenceResult.evidence,
  evidenceValid,
};
```

`analyzePromotion()` already converts `evidenceValid: false` to the blocking `case.evidence_invalid` issue, so activation remains impossible.

- [ ] **Step 5: Add direct semantics, promotion, and report regressions**

Create `tests/unit/evidence-semantics.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { runEventSchema, type RunEvent } from "../../src/core/runs/schema.js";
import { validatePassEvidenceFreshness } from "../../src/services/run-protocol/evidence-semantics.js";

function event(
  sequence: number,
  id: string,
  type: RunEvent["type"],
  payload: unknown,
): RunEvent {
  return runEventSchema.parse({
    schemaVersion: 1,
    id,
    runId: "run-1",
    sequence,
    timestamp: new Date(sequence * 1000).toISOString(),
    actor: type === "evidence" ? "ai-qa" : "agent",
    platform: "web",
    tool: type === "evidence" || type === "assertion"
      ? "ai-qa"
      : "chrome-devtools-mcp",
    type,
    payload,
    relatedIds: [],
  });
}

const events: RunEvent[] = [
  event(1, "event-observe", "action", {
    phase: "planned",
    kind: "observation",
    intent: "Observe initial state",
    stepId: "step-initial",
    target: { description: "Current page" },
  }),
  event(2, "event-observe-complete", "action", {
    phase: "completed",
    actionId: "event-observe",
    toolResult: { summary: "Initial state observed" },
  }),
  event(3, "event-observation", "observation", {
    summary: "Login form is visible",
    state: { screen: "login" },
    stepId: "step-initial",
    actionId: "event-observe",
  }),
  event(4, "event-capture", "action", {
    phase: "planned",
    kind: "evidence-capture",
    intent: "Capture initial state",
    stepId: "step-initial",
    target: { description: "Login form" },
  }),
  event(5, "event-capture-complete", "action", {
    phase: "completed",
    actionId: "event-capture",
    toolResult: { summary: "Initial screenshot captured" },
  }),
  event(6, "event-evidence", "evidence", {
    schemaVersion: 1,
    id: "evidence-old",
    runId: "run-1",
    projectRelativePath: ".ai-qa/evidence/run-1/files/evidence-old-screen.png",
    contentHash: `sha256:${"0".repeat(64)}`,
    mediaType: "image/png",
    platform: "web",
    sourceTool: "chrome-devtools-mcp",
    capturedAt: "2026-07-13T00:00:06.000Z",
    classification: "raw",
    sensitivity: "internal",
    evidenceKinds: ["post-action-screenshot"],
    captureActionId: "event-capture",
    idempotencyKey: "capture-old",
    criterionIds: ["authenticated-home-visible"],
    observationIds: ["event-observation"],
  }),
  event(7, "event-submit", "action", {
    phase: "planned",
    kind: "interaction",
    intent: "Submit valid credentials",
    stepId: "step-submit",
    target: { description: "Login button" },
  }),
  event(8, "event-submit-complete", "action", {
    phase: "completed",
    actionId: "event-submit",
    toolResult: { summary: "Credentials submitted" },
  }),
  event(9, "event-assertion", "assertion", {
    criterionId: "authenticated-home-visible",
    status: "satisfied",
    assertionKinds: ["semantic-ui"],
    actual: "Authenticated home is visible",
    expected: "Authenticated home is visible",
    observationIds: ["event-observation"],
    evidenceIds: ["evidence-old"],
    stepId: "step-submit",
  }),
];

describe("validatePassEvidenceFreshness", () => {
  it("rejects evidence captured before its asserted interaction", () => {
    let thrown: unknown;
    try {
      validatePassEvidenceFreshness(events, {
        classification: "pass",
        summary: "Login verified",
        criterionResults: [
          {
            criterionId: "authenticated-home-visible",
            status: "satisfied",
            assertionIds: ["event-assertion"],
            evidenceIds: ["evidence-old"],
          },
        ],
      });
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "verdict.stale_post_action_evidence",
    });
  });
});
```

In `tests/integration/case-promotion.test.ts`, append the same schema-valid stale completed history through `RunJournal`, draft from it, and assert:

```ts
expect(draft.promotion.validationIssues).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ code: "case.evidence_invalid" }),
  ]),
);
```

In `tests/integration/report-generation.test.ts`, use that stale completed history and assert:

```ts
await expect(
  generateRunReport({ ...project, runId: "run-1", now: generatedNow }),
).rejects.toMatchObject({ code: "verdict.stale_post_action_evidence" });
await expect(
  access(join(project.projectRoot, ".ai-qa", "reports", "runs", "run-1")),
).rejects.toMatchObject({ code: "ENOENT" });
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm vitest run tests/unit/evidence-semantics.test.ts tests/integration/run-finalize.test.ts tests/integration/case-promotion.test.ts tests/integration/report-generation.test.ts
pnpm typecheck
```

Expected: PASS; existing valid observation-then-capture flows remain valid while proof predating its asserted interaction cannot support pass, promotion, or reporting.

```bash
git add src/services/run-protocol/evidence-semantics.ts src/services/run-protocol/finalize-run.ts src/services/case-promotion/draft-case.ts tests/unit/evidence-semantics.test.ts tests/integration/run-finalize.test.ts tests/integration/case-promotion.test.ts tests/integration/report-generation.test.ts
git commit -m "fix: bind pass evidence to post-action state"
```

---

### Task 6: Lifecycle-Owned Cancellation and Idempotent Initial Verdicts

**Files:**
- Modify: `src/services/run-protocol/verdict-service.ts:57-165, 208-300`
- Modify: `src/services/report-generation/generate-run-report.ts:190-230, 430-465`
- Modify: `tests/integration/verdict-service.test.ts:57-230`
- Modify: `tests/integration/run-finalize.test.ts:723-770`
- Modify: `tests/integration/report-generation.test.ts:325-370`

**Interfaces:**
- Consumes: Existing canonical verdict hash/idempotency key, verdict history, and cancel lifecycle.
- Produces: `requireLifecycleOwnedCancellation(payload): void`; normal set/revise reject `not_verified/cancelled`, exact initial-set retry returns the original event, and cancellation verdicts always have zero criterion citations.

- [ ] **Step 1: Write failing verdict tests**

Add to `tests/integration/verdict-service.test.ts`:

```ts
it("returns the original event for an exact initial verdict retry", async () => {
  const { service, repository } = await createRun();
  const input = {
    classification: "not_verified" as const,
    reasonCode: "incomplete_coverage" as const,
    summary: "Coverage is incomplete",
    criterionResults: [],
  };

  const first = await service.set(input);
  const retry = await service.set(input);

  expect(retry.id).toBe(first.id);
  expect(
    (await repository.journal("run-1").readAll()).filter(
      (event) => event.type === "verdict",
    ),
  ).toHaveLength(1);
});

it("reserves cancelled verdicts for the cancel lifecycle", async () => {
  const { service } = await createRun();
  await expect(
    service.set({
      classification: "not_verified",
      reasonCode: "cancelled",
      summary: "Forged cancellation",
      criterionResults: [
        {
          criterionId: "authenticated-home-visible",
          status: "satisfied",
          assertionIds: ["event-forged"],
          evidenceIds: ["evidence-forged"],
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "verdict.cancel_requires_lifecycle" });
});
```

- [ ] **Step 2: Add the forged cancelled-report regression**

In `tests/integration/report-generation.test.ts`, use the cancelled-report setup but call normal `VerdictService.set()` with `reasonCode: "cancelled"` and forged IDs before `cancelRun()`. Assert the set rejects, then cancel normally and verify the generated report has `criterionResults: []`.

- [ ] **Step 3: Run tests and observe current failures**

Run:

```bash
pnpm vitest run tests/integration/verdict-service.test.ts tests/integration/report-generation.test.ts -t "initial verdict retry|cancelled verdict|cancelled report"
```

Expected: FAIL because exact initial retry returns `verdict.already_set`, and normal set currently accepts a cancellation verdict with criterion citations.

- [ ] **Step 4: Enforce cancellation ownership and initial retry semantics**

Add to `verdict-service.ts`:

```ts
function requireLifecycleOwnedCancellation(payload: VerdictPayload): void {
  if (
    payload.classification === "not_verified" &&
    payload.reasonCode === "cancelled"
  ) {
    throw new AiQaError(
      "verdict.cancel_requires_lifecycle",
      "Cancelled verdicts can only be created by run cancel",
    );
  }
}

function requireCanonicalCancellationShape(payload: VerdictPayload): void {
  if (
    payload.classification === "not_verified" &&
    payload.reasonCode === "cancelled" &&
    payload.criterionResults.length !== 0
  ) {
    throw new AiQaError(
      "run_protocol.integrity_error",
      "Cancellation verdicts cannot contain criterion results",
    );
  }
}
```

Call `requireLifecycleOwnedCancellation(payload)` at the start of public `set()` and `revise()`, but not from `recordCancellation()`.

Inside `set()`'s prepared callback, construct the candidate before the cardinality check and recognize the exact retry:

```ts
const candidate = verdictAppendInput(payload);
const retry = verdicts.find(
  ({ event }) =>
    event.idempotencyKey === candidate.idempotencyKey &&
    canonicalJson(event.payload) === canonicalJson(payload),
);
if (retry !== undefined) return candidate;
if (verdicts.length !== 0) {
  throw new AiQaError(
    "verdict.already_set",
    "Use verdict revise after the initial verdict",
  );
}
return candidate;
```

Call `requireCanonicalCancellationShape(payload)` for every verdict parsed in `validateVerdictHistory()`. In `recordCancellation()`, only reuse a current cancellation when summary matches **and** `criterionResults.length === 0`.

- [ ] **Step 5: Tighten cancelled report validation**

Extend `validateTerminalVerdict()`'s cancelled branch:

```ts
if (
  verdict.classification !== "not_verified" ||
  verdict.reasonCode !== "cancelled" ||
  verdict.criterionResults.length !== 0 ||
  reason !== verdict.summary
) {
  throw new AiQaError(
    "run_protocol.integrity_error",
    "Cancelled lifecycle does not match its canonical cancellation verdict",
    { runId: terminal.runId },
  );
}
```

- [ ] **Step 6: Run tests and commit**

Run:

```bash
pnpm vitest run tests/integration/verdict-service.test.ts tests/integration/run-finalize.test.ts tests/integration/report-generation.test.ts
pnpm typecheck
```

Expected: PASS; only `cancelRun()` creates cancellation verdicts, cancelled reports have no citations, and exact set retries remain one event.

```bash
git add src/services/run-protocol/verdict-service.ts src/services/report-generation/generate-run-report.ts tests/integration/verdict-service.test.ts tests/integration/run-finalize.test.ts tests/integration/report-generation.test.ts
git commit -m "fix: make cancellation lifecycle owned"
```

---

### Task 7: Serialize Multi-Format Report Generation and Export

**Files:**
- Modify: `src/services/report-generation/generate-run-report.ts:1-160`
- Modify: `tests/integration/report-generation.test.ts:217-296, 602-790`

**Interfaces:**
- Consumes: Verified report directory, `proper-lockfile`, `atomicWriteFile()`, immutable terminal run state.
- Produces: `withReportLock(directory, operation): Promise<T>`; JSON/Markdown writes and export reads for one run are mutually exclusive.

- [ ] **Step 1: Write a failing lock-serialization test**

Add `proper-lockfile` to the report test imports. Generate once to create the report directory, acquire an external directory lock, start a second generation, and assert it cannot settle until release:

```ts
it("waits for the per-run report lock before replacing an artifact set", async () => {
  const fixture = await completedRun();
  await generateRunReport({ ...fixture, runId: "run-1", now: generatedNow });
  const directory = join(
    fixture.projectRoot,
    ".ai-qa",
    "reports",
    "runs",
    "run-1",
  );
  const release = await lockfile.lock(directory, { realpath: false });
  let settled = false;
  const generation = generateRunReport({
    ...fixture,
    runId: "run-1",
    now: () => new Date("2026-07-13T00:30:00.000Z"),
  }).finally(() => {
    settled = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  await release();
  await expect(generation).resolves.toMatchObject({
    jsonPath: ".ai-qa/reports/runs/run-1/report.json",
    markdownPath: ".ai-qa/reports/runs/run-1/report.md",
  });
});
```

- [ ] **Step 2: Run the test and verify generation ignores the lock**

Run:

```bash
pnpm vitest run tests/integration/report-generation.test.ts -t "report lock"
```

Expected: FAIL because generation settles while the externally held directory lock remains active.

- [ ] **Step 3: Add a shared report lock**

Import `proper-lockfile` and add:

```ts
async function withReportLock<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await lockfile.lock(directory, {
    realpath: false,
    retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}
```

Wrap the complete artifact-set write in `generateRunReport()`:

```ts
await withReportLock(directory, async () => {
  const writes: Promise<void>[] = [];
  if (paths.jsonPath !== undefined) {
    writes.push(atomicWriteFile(resolve(directory, "report.json"), json));
  }
  if (paths.markdownPath !== undefined) {
    writes.push(atomicWriteFile(resolve(directory, "report.md"), markdown));
  }
  await Promise.all(writes);
});
```

Wrap all persisted artifact validation/reads in `exportProjectLocalRunReport()` with the same lock. Keep `buildVerifiedRunReport()` before lock acquisition because terminal run state is immutable; do not hold the report lock while taking the run journal lock.

- [ ] **Step 4: Test concurrent generations produce one coherent pair**

Run two generations with distinct `now()` timestamps using `Promise.all()`, then call export and compare persisted JSON's `integrity.verifiedAt` to the Markdown `Verified at ...` footer. Assert export succeeds and both timestamps are identical.

```ts
expect(markdown).toContain(`Verified at ${json.integrity.verifiedAt}.`);
await expect(
  exportProjectLocalRunReport({ ...fixture, runId: "run-1", now: generatedNow }),
).resolves.toBeDefined();
```

- [ ] **Step 5: Run report tests and commit**

Run:

```bash
pnpm vitest run tests/integration/report-generation.test.ts
pnpm typecheck
```

Expected: PASS; generate/generate and generate/export operations cannot observe mixed JSON/Markdown generations.

```bash
git add src/services/report-generation/generate-run-report.ts tests/integration/report-generation.test.ts
git commit -m "fix: serialize report artifact sets"
```

---

### Task 8: Normalize Missing Runs and Unexpected CLI Failures

**Files:**
- Modify: `src/core/errors.ts:1-15`
- Modify: `src/core/runs/journal.ts:75-142`
- Modify: `src/cli/program.ts:70-135`
- Create: `tests/unit/errors.test.ts`
- Modify: `tests/integration/run-journal.test.ts`
- Modify: `tests/integration/run-finalize.test.ts:883-1100`

**Interfaces:**
- Consumes: `AiQaError`, Node `ErrnoException`, Commander/Zod error branches.
- Produces: `normalizeUnknownError(error): AiQaError`; a missing run becomes `run.not_found`, other filesystem failures become `filesystem.operation_failed`, and non-filesystem unknowns become `internal.unexpected_error`.

- [ ] **Step 1: Write failing structured-error tests**

Add a CLI test that calls `run finish run-missing` in a trusted initialized project and asserts:

```ts
expect(exitCode).toBe(1);
expect(JSON.parse(captured.stderr.join(""))).toEqual({
  error: {
    code: "run.not_found",
    message: "Run does not exist",
    details: { runId: "run-missing" },
  },
});
expect(captured.stderr.join("").toLowerCase()).not.toContain("stack");
```

Create `tests/unit/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeUnknownError } from "../../src/core/errors.js";

describe("normalizeUnknownError", () => {
  it("converts a node filesystem failure without leaking its message", () => {
    const error = Object.assign(new Error("secret path /private/project"), {
      code: "EIO",
      syscall: "read",
    });

    expect(normalizeUnknownError(error)).toMatchObject({
      code: "filesystem.operation_failed",
      message: "A filesystem operation failed",
      details: { code: "EIO", syscall: "read" },
    });
    expect(normalizeUnknownError(error).message).not.toContain("/private/project");
  });

  it("converts a non-system exception to the generic internal contract", () => {
    expect(normalizeUnknownError(new Error("private detail"))).toMatchObject({
      code: "internal.unexpected_error",
      message: "An unexpected internal error occurred",
      details: {},
    });
  });
});
```

- [ ] **Step 2: Run tests and verify raw errors escape**

Run:

```bash
pnpm vitest run tests/unit/errors.test.ts tests/integration/run-finalize.test.ts -t "missing run|filesystem"
```

Expected: FAIL because `proper-lockfile` raises raw `ENOENT` and `runCli()` rethrows unrecognized errors.

- [ ] **Step 3: Add safe unknown-error normalization**

Append to `src/core/errors.ts`:

```ts
export function normalizeUnknownError(error: unknown): AiQaError {
  if (error instanceof AiQaError) return error;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as NodeJS.ErrnoException).code === "string"
  ) {
    const nodeError = error as NodeJS.ErrnoException;
    return new AiQaError(
      "filesystem.operation_failed",
      "A filesystem operation failed",
      {
        code: nodeError.code,
        ...(nodeError.syscall === undefined ? {} : { syscall: nodeError.syscall }),
      },
    );
  }
  return new AiQaError(
    "internal.unexpected_error",
    "An unexpected internal error occurred",
  );
}
```

Do not include raw messages, paths, stacks, or serialized input in fallback details.

- [ ] **Step 4: Map a missing journal before general normalization**

Factor journal locking through:

```ts
private async lock(): Promise<() => Promise<void>> {
  try {
    await requireProjectLocalRegularFile(this.projectRoot, [
      ".ai-qa",
      "runs",
      this.runId,
      "events.jsonl",
    ]);
    return await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 3, minTimeout: 50 },
    });
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw new AiQaError("run.not_found", "Run does not exist", {
        runId: this.runId,
      });
    }
    if (
      error instanceof AiQaError &&
      error.code === "storage.integrity_error" &&
      isMissingStoragePath(error)
    ) {
      throw new AiQaError("run.not_found", "Run does not exist", {
        runId: this.runId,
      });
    }
    throw error;
  }
}
```

Task 1's storage error preserves `{ path, causeCode: "ENOENT" }` for missing files. Add:

```ts
function isMissingStoragePath(error: AiQaError): boolean {
  return error.details.causeCode === "ENOENT";
}
```

Use `this.lock()` in both `readLocked()` and `appendPrepared()`; do not infer missing state from message text.

- [ ] **Step 5: Use the fallback in `runCli()`**

Replace the final `throw error` branch with:

```ts
const normalized = normalizeUnknownError(error);
context.writeStderr(
  `${JSON.stringify({
    error: {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    },
  })}\n`,
);
return 1;
```

Import `normalizeUnknownError` beside `AiQaError`. Preserve the more specific Commander, `AiQaError`, and `ZodError` branches above it.

- [ ] **Step 6: Run error tests and commit**

Run:

```bash
pnpm vitest run tests/unit/errors.test.ts tests/integration/run-journal.test.ts tests/integration/run-finalize.test.ts
pnpm typecheck
```

Expected: PASS; all CLI paths return a single parseable JSON error and missing run operations consistently use `run.not_found`.

```bash
git add src/core/errors.ts src/core/fs/project-storage.ts src/core/runs/journal.ts src/cli/program.ts tests/unit/errors.test.ts tests/integration/run-journal.test.ts tests/integration/run-finalize.test.ts
git commit -m "fix: keep cli failures inside the json contract"
```

---

### Task 9: Agent Protocol Documentation and Full Regression Gate

**Files:**
- Modify: `src/skills/global/SKILL.md`
- Modify: `src/skills/global/references/web-work-protocol.md`
- Modify: `docs/validation/web-live-acceptance.md`
- Modify: `docs/superpowers/specs/2026-07-13-ai-qa-design.md`
- Modify: `tests/e2e/web-vertical-slice.test.ts`
- Modify: `tests/e2e/cli-web-vertical-slice.test.ts`

**Interfaces:**
- Consumes: Tasks 1-8 public behavior and error codes.
- Produces: Agent-facing instructions that exactly match controller, evidence timing, cancellation, storage, and retry behavior; the complete vertical slice remains green.

- [ ] **Step 1: Update the Web work protocol with exact invariants**

Add these normative statements to `src/skills/global/references/web-work-protocol.md`:

```markdown
## Controller provenance

- Every Web `action plan` uses `tool: "chrome-devtools-mcp"`.
- Every evidence add uses `sourceTool: "chrome-devtools-mcp"`, matching its completed evidence-capture action.
- Do not relabel output from another controller as Chrome DevTools evidence.

## Post-action evidence

- Record the interaction, its terminal result, and a fresh observation before capturing `post-action-screenshot` evidence.
- Use one `stepId` for the interaction, fresh observation, evidence capture, and satisfied assertion.
- Evidence captured before the asserted interaction cannot support a pass, case promotion, or a report.

## Cancellation and retries

- Use `ai-qa run cancel`; never submit `not_verified/cancelled` through `verdict set` or `verdict revise`.
- Retrying an identical initial verdict is safe and returns the original event.
```

Mirror the concise command-level requirements in `src/skills/global/SKILL.md`.

- [ ] **Step 2: Record the corrected integrity contract in the design**

Update the storage/concurrency/protocol sections of the design spec to state:

```markdown
- All `.ai-qa` ancestors and artifacts are lstat/realpath verified; symlinks are rejected.
- Journal and evidence index commits use locked atomic replacement with mandatory final newlines.
- Evidence index records and typed evidence events have exact one-to-one canonical parity.
- Multi-format report generation/export uses one per-run report-directory lock.
- Cancellation verdicts are lifecycle-owned and contain no criterion results.
```

- [ ] **Step 3: Extend the end-to-end test assertions**

In both E2E tests, assert the final event/evidence/report invariants:

```ts
expect(workOrder.platform).toBe("web");
expect(actionEvents.every((event) => event.tool === "chrome-devtools-mcp")).toBe(true);
expect(evidenceRecords.every((record) => record.sourceTool === "chrome-devtools-mcp")).toBe(true);
expect(new Set(evidenceRecords.map((record) => record.id)).size).toBe(
  evidenceRecords.length,
);
expect(markdown).toContain(`Verified at ${json.integrity.verifiedAt}.`);
```

Keep the full init → doctor → exploratory action → fresh observation → screenshot → pass → finish → draft → activate → regression replay → report/export path.

- [ ] **Step 4: Run targeted regression suites**

Run:

```bash
pnpm vitest run tests/unit tests/integration
pnpm vitest run tests/e2e/web-vertical-slice.test.ts tests/e2e/cli-web-vertical-slice.test.ts
```

Expected: all tests pass with no skipped integrity regression.

- [ ] **Step 5: Run the complete package quality gate**

Run:

```bash
pnpm format
pnpm check
git diff --check
npm_config_cache=/tmp/ai-qa-hardening-npm-cache npm pack --dry-run --ignore-scripts --json
git status --short
```

Expected:

- Prettier, ESLint, TypeScript, all Vitest tests, and production build pass.
- `git diff --check` prints nothing.
- The package dry run includes only package metadata, README, `dist`, and bundled skill assets.
- `git status --short` contains only the intended source, test, documentation, and plan changes before commit.

- [ ] **Step 6: Perform the manual live Web check when Chrome DevTools MCP is available**

Follow `docs/validation/web-live-acceptance.md` against a disposable trusted project. Confirm the real MCP-driven action/observation/screenshot uses `chrome-devtools-mcp`, finish succeeds, evidence hashes reverify, and JSON/Markdown export agrees. Record the date, CLI commit, Chrome version, MCP version, run ID, case revision, verdict, and report paths in the validation document.

- [ ] **Step 7: Commit documentation and final regression coverage**

```bash
git add src/skills/global/SKILL.md src/skills/global/references/web-work-protocol.md docs/validation/web-live-acceptance.md docs/superpowers/specs/2026-07-13-ai-qa-design.md tests/e2e/web-vertical-slice.test.ts tests/e2e/cli-web-vertical-slice.test.ts
git commit -m "docs: align web protocol with integrity hardening"
```

## Self-Review Results

- **Spec coverage:** Tasks 1-8 cover all eight Important findings and all three Minor findings: cancellation integrity, project-local symlink confinement, exact evidence parity, controller provenance, post-action freshness, stable initialization identity, report concurrency, crash-safe JSONL, verdict retry idempotency, structured filesystem errors, and trust lost updates. Task 9 synchronizes the design, Agent Skill, E2E path, package gate, and live validation procedure.
- **Scope boundary:** No npm publication, mobile platform, CI runner, RunGroup, external storage adapter, or setup automation is introduced.
- **Placeholder scan:** Every task names exact files, test commands, expected failures/passes, concrete interfaces, implementation code, and commit boundaries; no deferred implementation markers remain.
- **Type consistency:** `WEB_CONTROLLER`, `validateEvidenceParity()`, `validatePassEvidenceFreshness()`, project-storage helpers, JSONL helpers, and `normalizeUnknownError()` use the same names and signatures at every call site in this plan.
