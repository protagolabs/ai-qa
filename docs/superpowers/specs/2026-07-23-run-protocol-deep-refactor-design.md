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
    "details": {},
    "issues": [
      { "path": ["readiness", "status"], "code": "invalid_value", "message": "..." }
    ]
  }
}
```

- `AiQaError` gains optional `retryable: boolean` (default false; serialized only when true) and a structured `cause` in `details` (`{ code, message }`) so wrapped errors keep their origin.
- `readJsonInput` separates failure modes: `JSON.parse` failure reports `input.invalid_json` with the parser message; Zod failure reports the new code `input.schema_invalid` with an `issues` array (path, Zod issue code, message per issue). The top-level ZodError handler emits the same `issues` shape and drops the old `issuePaths`-only form.
- New `core/fs/locking.ts` wraps every `proper-lockfile` acquisition. Two profiles: `hot` (journal; 10 retries from 50 ms with exponential backoff capped at 1 s) and `cold` (repositories; today's 20-retry envelope). `ELOCKED` maps to `storage.lock_contended` with `retryable: true` and the contended path; a compromised lock maps to `storage.lock_compromised`. All twelve call sites move to this module.
- `RunJournal.readAll` stops blanket-catching: Node fs errors surface as `filesystem.operation_failed` with the original `code` in `details.cause`; only invariant and parse failures report `journal.integrity_error`, now carrying the underlying reason. `validateProtocolEvents` no longer rewrites nested `AiQaError`s (for example `recovery.retry_not_permitted`) into `run_protocol.integrity_error`; domain errors propagate unchanged.
- The unknown-command remap in `runCli` is deleted; `commander.unknownCommand` passes through with commander's own message. `--version` reads the version from the package's own `package.json` via `createRequire` instead of the hardcoded `0.0.0`.

## Section 2: Typed run events

`runEventSchema` becomes a discriminated union on `type`. Each event type binds the payload schema that already exists in `core/runs/event-payloads.ts`; `payload: jsonValueSchema` disappears from the event envelope. The JSONL disk format is unchanged. Data written by 0.1.0 parses under the union because every payload was validated by the same payload schema before being written.

`readAll` therefore yields fully typed events in one parse. Downstream validators consume the typed union directly and perform no further Zod parsing. `tool` and `relatedIds` keep their current permissive schemas (tightening them would be a disk-compat risk for no protocol benefit).

## Section 3: RunSession — one lock, one read, one validation per command

New `services/run-protocol/run-session.ts`. A session acquires the journal lock once, reads and parses the journal once, loads the verified work order once, and exposes an immutable `RunSnapshot` (work order, typed events, derived lifecycle state). Every CLI protocol command runs against exactly one session.

- All validators (`validateProtocolEvents`, `validateVerdictHistory`, lifecycle checks, regression fidelity) become pure functions over `RunSnapshot`. `readVerifiedWorkOrder` accepts the snapshot instead of re-reading the journal.
- Incremental checks that currently rescan `events.slice(0, index)` per event (recovery retry permission, regression fidelity interaction counting) are rewritten as single-pass accumulators, making full validation O(n).
- `session.append(events)` appends one or more events inside the same critical section. `cancelRun` collapses its three lock acquisitions into one: validation, the cancellation verdict event, and the `cancelled` lifecycle event commit together.
- Appends return the event plus the post-append state and `permittedNextActions`, computed from the in-lock snapshot. `writeProtocolEvent` prints that result and no longer re-resolves the project or re-reads state outside the lock, eliminating the read-back race and two of the three per-command project-root resolutions.

## Section 4: Append-only journal writes

`RunJournal` appends a single serialized line with fsync instead of rewriting `events.jsonl` on every event. Sequence, platform, and idempotency invariants are enforced in memory under the lock before the write, exactly as today.

The new failure mode is a torn trailing line after a crash mid-append. `readAll` distinguishes it: when every line parses except an incomplete final line, the error is the new repairable code `journal.torn_write`, whose message names `ai-qa run repair`. Any other malformation remains `journal.integrity_error`. A torn tail is an event that was never acknowledged to the caller, so truncating it is semantically safe — but only the explicit repair command performs the truncation, consistent with the project's no-automatic-deletion policy.

## Section 5: Evidence atomicity and `ai-qa run repair`

Registration order stays file-copy + index first, journal event second, but parity validation now classifies divergence:

- Index entries with no matching journal event are orphans from the crash window and report the repairable code `evidence.orphaned_entries`.
- Journal evidence events with no index entry remain `evidence.integrity_error` (true corruption).

New command:

```text
ai-qa run repair <run-id> [--project <path>]
```

Under the journal and evidence locks, repair moves orphaned index entries and their files, and any torn journal tail, into `.ai-qa/recovery/<run-id>/`, then reports JSON listing every relocated item. Repair is idempotent; a run with nothing to repair returns an empty report. Wedged runs regain `resume`, `finish`, and report generation once repaired.

Hot-path cost changes: `evidence add` no longer re-hashes all evidence after a successful append; `run resume` performs structural parity only; full content-hash verification runs at `run finish` and `report generate`.

Creation atomicity: `run start` sweeps stale `.run-staging-*` directories (older than one hour by `context.now`) before creating a run; RunGroup creation writes `events.jsonl` first so `group.json` becomes the commit point, and a group directory without `group.json` reads as `run_group.not_found`.

## Section 6: Cleanup, CI exit codes, version

- `isNodeError` (12 copies), `isRecord` (6), and `appendInput` (4) consolidate into shared core modules.
- Deleted: `core/tools.ts` re-export shell (tests import the real modules), `RunJournal.create` (production uses staging + `open`), `RunGroupRepository.readManifest`/`readEvents`, `checkGlobalSkillForProject` (its `recordingMode` input never had effect).
- `CaseRepository` either uses its `now` parameter or the parameter is removed along with caller threading; the duplicated `validatePinnedRegressionCase` implementations merge into one; `CaseRepository.validateRevision` and `validateRevisionAgainstIndex` share one implementation; the git-root predicate in `resolve-project-root.ts` reduces to an existence check.
- Version literals for run-group events, case index, and recording move from inline numbers to `schemas/versions.ts` constants.
- CI exit-code parity (M10): `report generate` and `report export` for a single run whose work order has `execution: ci` honor `ciPolicy.nonPassExit` exactly as the group commands do.
- Package version bumps to 0.2.0.

## Testing

`pnpm check` stays green throughout. New regression coverage:

- Unknown-command output and `--version` correctness.
- `input.invalid_json` vs `input.schema_invalid` discrimination and the `issues` shape, including the top-level ZodError path.
- `storage.lock_contended` mapping under a deliberately held lock.
- Torn-journal detection and repair; orphaned-evidence detection and repair; repair idempotency.
- `cancelRun` single-critical-section behavior (no intermediate state observable between verdict and lifecycle events).
- Journal append does not rewrite the file (assert via inode/size growth on append).
- Single-run CI exit codes under `ciPolicy.nonPassExit: failure`.

## Delivery

Four milestones, each an independently green commit:

1. Error layer and lock consolidation (Section 1).
2. Typed events (Section 2).
3. RunSession and append-only writes (Sections 3–4).
4. Evidence repair, cleanup, CI exit codes, version bump (Sections 5–6).
