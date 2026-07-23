# Run Protocol Deep Refactor and Error Contract Design

Date: 2026-07-23

## Goal

Fix the code-quality findings from the 2026-07-23 review in one coordinated refactor, released as 0.2.0:

- Structured, actionable CLI errors for agent consumers (review findings H1, H2, H4, M4, L1).
- Typed run events and a single-pass validation pipeline that removes the O(n²)–O(n³) journal cost (H3, M6, M7, L6).
- Crash-safe evidence registration with an explicit repair path (H5, M3, L4, L5).
- Dead-code removal, duplication cleanup, and CI exit-code parity for single runs (M1, M8, M9, M10).

Breaking changes to CLI JSON output and error codes are acceptable. On-disk formats for journals, configs, cases, evidence, and reports do not change; projects written by 0.1.0 remain readable.

## Non-goals

- No changes to the Skill contract, controller references, or install flow (tracked separately as Claude Code adaptation work).
- No schema-version migration framework (M2 remains future work; this refactor only centralizes version literals).
- No changes to RunGroup aggregation semantics, verdict classification, or report content.

## Section 1: Error layer and CLI output contract

The stderr error contract becomes:

```json
{
  "error": {
    "code": "input.schema_invalid",
    "message": "stdin JSON does not match the expected schema",
    "issues": [
      { "path": ["readiness", "status"], "code": "invalid_value", "message": "..." }
    ]
  }
}
```

- `AiQaError` gains optional `retryable: boolean` (default false; serialized only when true) and a structured `cause` in `details` (`{ code, message }`) so wrapped errors keep their origin.
- `readJsonInput` separates failure modes: `JSON.parse` failure reports `input.invalid_json` with the parser message; Zod failure reports the new code `input.schema_invalid` with an `issues` array (path, Zod issue code, message per issue). The top-level ZodError handler (CLI options and other non-stdin validation) keeps the code `schema.validation_failed` but emits the same `issues` shape, replacing the `issuePaths`-only form. `details` and `issues` are omitted when empty; `code` and `message` are always present.
- New `core/fs/locking.ts` exposes an operation-scoped `withLock(path, profile, callback)` — not a bare acquisition wrapper — because `proper-lockfile` signals a compromised lock asynchronously through `onCompromised` while the lock is held. Compromise handling makes no retry promise: `withLock` forwards a compromise signal into the callback, which checks it at each write boundary and aborts; `withLock` always waits for the callback to settle (never abandoning a possibly-still-writing callback) and then reports `storage.lock_compromised` with no `retryable` flag — the operation's outcome is unknown. Racing past the callback is forbidden precisely because an abandoned callback plus a retry would run two concurrent writers, and the wrapper also guards case, report, evidence, and RunGroup writes, which have no idempotency keys. The caller's recovery path is to re-inspect state first; a reissued journal command is then deduplicated by its idempotency key under a fresh lock. Two profiles: `hot` (journal; 10 retries from 50 ms with exponential backoff capped at 1 s) and `cold` (repositories; today's 20-retry envelope). `ELOCKED` maps to `storage.lock_contended` with `retryable: true` and the contended path. All nine `lockfile.lock` call sites move to this module.
- `RunJournal.readAll` stops blanket-catching: Node fs errors surface as `filesystem.operation_failed` with the original `code` in `details.cause`; only invariant and parse failures report `journal.integrity_error`, now carrying the underlying reason. `validateProtocolEvents` no longer rewrites nested `AiQaError`s (for example `recovery.retry_not_permitted`) into `run_protocol.integrity_error`; domain errors propagate unchanged.
- The unknown-command remap in `runCli` is deleted; `commander.unknownCommand` passes through with commander's own message. `--version` reads the version from the package's own `package.json` via `createRequire` instead of the hardcoded `0.0.0`.

## Section 2: Typed run events

`runEventSchema` becomes a discriminated union on `type`; `payload: jsonValueSchema` disappears from the event envelope. The JSONL disk format is unchanged. Data written by 0.1.0 parses under the union because every payload was validated by the same payload schema before being written.

The payload schemas are today spread across `core/runs/event-payloads.ts`, `core/runs/lifecycle.ts` (private `lifecyclePayloadSchema`), and `core/verdicts/schema.ts`, and all of them import ID schemas from `core/runs/schema.ts` — composing the union inside `schema.ts` as-is would create an ESM initialization cycle. Milestone 2 therefore starts by extracting the ID schemas and the event envelope into a dependency-free module (`core/runs/ids.ts`); payload modules import from there, `lifecyclePayloadSchema` becomes exported, and `schema.ts` becomes the composition point that imports payloads without being imported by them. `AppendRunEvent` is derived with a distributive omit over the union so the `type`↔`payload` correlation survives in the append API.

`readAll` therefore yields fully typed events in one parse. Downstream validators consume the typed union directly and perform no further Zod parsing. `tool` and `relatedIds` keep their current permissive schemas (tightening them would be a disk-compat risk for no protocol benefit).

## Section 3: RunSession — one lock, one read, one validation per command

New `services/run-protocol/run-session.ts`. A session acquires the journal lock once, reads and parses the journal once, verifies the work order against those parsed events, and assembles the two into an immutable `RunSnapshot` (work order, typed events, derived lifecycle state). Every CLI protocol command runs against exactly one session.

- All validators (`validateProtocolEvents`, `validateVerdictHistory`, lifecycle checks, regression fidelity) become pure functions over `RunSnapshot`. `readVerifiedWorkOrder` becomes a snapshot-assembly step taking the parsed events as input — it no longer re-reads the journal, and the snapshot is only constructed once its result is available.
- Incremental checks that currently rescan `events.slice(0, index)` per event (recovery retry permission, regression fidelity interaction counting) are rewritten as single-pass accumulators, making full validation O(n).
- `session.append(events)` appends one or more events inside the same critical section. `cancelRun` collapses its three lock acquisitions into one: validation, the cancellation verdict event, and the `cancelled` lifecycle event commit together. `resumeRun`'s two lifecycle appends go through the same batch path.
- Appends return the event plus the post-append state and `permittedNextActions`, computed from the in-lock snapshot. `writeProtocolEvent` prints that result and no longer re-resolves the project or re-reads state outside the lock, eliminating the read-back race and two of the three per-command project-root resolutions.

## Section 4: Append-only journal writes

Single-event appends — the hot path (`action plan`/`complete`, observations, evidence, assertions) — append one serialized line with fsync instead of rewriting `events.jsonl`. Sequence, platform, and idempotency invariants are enforced in memory under the lock before the write, exactly as today.

Multi-event batch appends (cancel, resume) do not use line appends: a crash between lines would commit a partial batch, and tail truncation could then expose exactly the intermediate state the single-critical-section design exists to prevent (for example a cancellation verdict without its `cancelled` lifecycle event). Batches instead use the existing atomic full-file rewrite (temp file + rename + directory fsync), which is all-or-nothing under crash. Batch appends are rare, so single-event journal write amplification is O(1) while batches keep crash atomicity with no new on-disk constructs. Per-command cost overall remains O(n): every command still reads and validates the full journal once when building its snapshot — the refactor removes the redundant re-reads and re-parses, not the single necessary pass.

The remaining failure mode is a torn trailing line after a crash mid-single-append. The torn-write condition is precisely: the file is non-empty and does not end with a newline. An incomplete final line is torn whether or not its bytes happen to parse as JSON — a complete JSON tail without a terminating newline is still unsafe to append after. A newline-terminated line that fails to parse is not torn; it remains `journal.integrity_error`. `readAll` reports a torn tail as the new repairable code `journal.torn_write`, whose message names `ai-qa run repair`. A torn tail is an event that was never acknowledged to the caller, so truncating it is semantically safe — but only the explicit repair command performs the truncation, consistent with the project's no-automatic-deletion policy.

## Section 5: Evidence atomicity and `ai-qa run repair`

Registration order stays file-copy + index first, journal event second, but parity validation now classifies divergence:

- Index entries with no matching journal event are orphans from the crash window and report the repairable code `evidence.orphaned_entries`.
- Journal evidence events with no index entry remain `evidence.integrity_error` (true corruption).

New command:

```text
ai-qa run repair <run-id> [--project <path>]
```

Repair relocates orphaned index entries and their files, and any torn journal tail, into `.ai-qa/recovery/<run-id>/`, then reports JSON listing every relocated item. A run with nothing to repair returns an empty report. Wedged runs regain `resume`, `finish`, and report generation once repaired.

Repair is itself multi-step I/O and must be crash-safe, or an interrupted repair would convert a repairable orphan into real corruption (an index entry pointing at a relocated file). Lock acquisition follows the global order the rest of the codebase already uses — journal lock first, evidence lock nested inside it, matching `evidence add` — so concurrent repair and registration cannot deadlock. Under both locks, repair follows a persistent-manifest protocol:

1. Compute the plan and atomically write `.ai-qa/recovery/<run-id>/repair-manifest.json` (planned relocations plus the journal truncation offset).
2. Copy — not move — orphaned evidence files and the torn tail bytes into the recovery directory (copies are idempotent).
3. Atomically rewrite the evidence index without the orphaned entries (temp + rename; the index commit point).
4. Truncate the journal at the recorded offset (a single `ftruncate`; the journal commit point).
5. Delete the orphaned source files, which nothing references anymore.
6. Mark the manifest complete.

A crash at any boundary leaves a manifest that a re-run of `run repair` resumes deterministically from the first unfinished step; every step is idempotent, which is what makes the command as a whole idempotent. Readers that encounter an incomplete manifest report the repairable `run.repair_incomplete` and name the command.

Hot-path cost changes: `evidence add` no longer re-hashes all evidence after a successful append; `run resume` performs structural parity only; full content-hash verification runs at `run finish` and `report generate`.

Creation atomicity: RunGroup creation adopts the same staging-plus-rename pattern run creation already uses — the group is assembled in a `.group-staging-*` directory and a single rename into place is the commit point. This avoids the trap of a write-ordering scheme, where a crash between the two writes leaves a directory that `create` rejects as `run_group.already_exists` while every read reports `run_group.not_found`. `run start` and `run-group start` sweep stale staging directories (older than one hour by `context.now`) before creating.

## Section 6: Cleanup, CI exit codes, version

- `isNodeError` (12 copies), `isRecord` (6), and `appendInput` (4) consolidate into shared core modules.
- Deleted: `core/tools.ts` re-export shell (tests import the real modules), `RunJournal.create` (production uses staging + `open`), `RunGroupRepository.readManifest`/`readEvents`, `checkGlobalSkillForProject` (its `recordingMode` input never had effect).
- `CaseRepository` either uses its `now` parameter or the parameter is removed along with caller threading; the duplicated `validatePinnedRegressionCase` implementations merge into one; `CaseRepository.validateRevision` and `validateRevisionAgainstIndex` share one implementation; the git-root predicate in `resolve-project-root.ts` reduces to an existence check.
- Version literals for run-group events, case index, and recording move from inline numbers to `schemas/versions.ts` constants.
- CI exit-code parity (M10): `report generate` and `report export` for a single run whose work order has `execution: ci` honor `ciPolicy.nonPassExit` by mirroring the group rule in `requestCiGroupFailure`: exit non-zero when the run is not `completed` or its effective verdict classification is anything other than `pass`. A cancelled run is non-pass.
- Package version bumps to 0.2.0.

## Testing

`pnpm check` stays green throughout. New regression coverage:

- Unknown-command output and `--version` correctness.
- `input.invalid_json` vs `input.schema_invalid` discrimination and the `issues` shape, including the top-level ZodError path.
- `storage.lock_contended` mapping under a deliberately held lock; `storage.lock_compromised` when the lock is compromised mid-operation, asserting the callback settled before the error surfaced and that no `retryable` flag is present.
- Concurrent `run repair` and `evidence add` complete without deadlock (lock-order test).
- Torn-tail classification across all four cases: complete JSON without trailing newline (torn), invalid JSON without trailing newline (torn, including a truncated multi-byte UTF-8 sequence), invalid JSON with trailing newline (integrity error), valid file (no error).
- Batch-append crash atomicity: a simulated crash during a cancel or resume batch leaves either zero or all of the batch's events.
- Orphaned-evidence detection and repair; crash-injection at every repair step boundary (after manifest write, after copies, after index rewrite, after truncation) followed by a resumed repair reaching the same final state; repair idempotency on a clean run.
- `cancelRun` single-critical-section behavior (no intermediate state observable between verdict and lifecycle events).
- Single-event journal append does not rewrite the file (assert via inode/size growth on append).
- Single-run CI exit codes under `ciPolicy.nonPassExit: failure`, including a cancelled run.

## Delivery

Four milestones, each an independently green commit:

1. Error layer and lock consolidation (Section 1).
2. Typed events (Section 2).
3. RunSession and append-only writes (Sections 3–4).
4. Evidence repair, cleanup, CI exit codes, version bump (Sections 5–6).
