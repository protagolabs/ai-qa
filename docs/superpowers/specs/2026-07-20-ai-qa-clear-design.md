# AI QA Project Clear Command Design

Date: 2026-07-20

## Goal

Add an idempotent `ai-qa clear` command that clears the selected project's AI QA configuration without deleting QA history by default. An explicit `--records` option expands the operation to delete all project-local AI QA state.

The command is intentionally non-interactive. Invoking it is the deletion confirmation; no additional prompt or confirmation flag is required.

## Public command contract

```text
ai-qa clear [--records] [--project <path>]
```

The existing global `--project <path>` option selects an exact target project and always takes precedence over implicit discovery.

Without `--project`, resolution follows this order:

1. the nearest ancestor containing `.ai-qa/config.yaml`;
2. the current Git repository root when no initialized ancestor exists.

The Git-root fallback makes the command repeatable after its first invocation removes the configuration. Outside Git, a target with no discoverable configuration requires explicit `--project <path>`.

Successful output is JSON with this shape:

```json
{
  "status": "cleared",
  "projectRoot": "/absolute/target/path",
  "records": false,
  "removedPaths": [
    ".ai-qa/config.yaml",
    ".agents/skills/ai-qa-project"
  ]
}
```

`records` reflects whether `--records` was supplied. `removedPaths` contains only project-relative paths that existed and were removed. It may be empty. Missing targets are a successful no-op, so the same command can be run repeatedly.

## Deletion scope

### Default mode

`ai-qa clear` removes exactly:

- `.ai-qa/config.yaml`; and
- the complete `.agents/skills/ai-qa-project/` directory.

It preserves the rest of `.ai-qa/`, including cases, runs, run groups, evidence, reports, recording receipts, and any other project-local QA history.

### Record-clearing mode

`ai-qa clear --records` removes exactly:

- the complete `.ai-qa/` directory; and
- the complete `.agents/skills/ai-qa-project/` directory.

This deletes all AI QA configuration and canonical QA history for the selected project. Other entries under `.agents/skills/` remain untouched.

The command does not remove now-empty parent directories such as `.agents/skills/` or `.agents/`.

## Architecture and data flow

The feature has three bounded components:

1. A CLI command module registers `clear`, accepts `--records`, resolves the target project, invokes the service, and writes the JSON result.
2. A project-clear service calculates the exact deletion set, preflights every removal through the storage layer, performs the prepared removals, and returns project-relative removed paths.
3. The existing project-storage layer remains the single owner of project containment, path ancestry, symlink, file-identity, and low-level removal safety.

The service receives a canonical project root and never performs ancestor discovery or duplicate filesystem-safety checks itself. This keeps selection policy in the existing project-root layer, deletion policy in one testable service, and filesystem integrity rules in the existing shared storage boundary.

The project resolver gains a clear-compatible mode with the same discovery behavior as initialization: prefer an existing configuration ancestor, otherwise fall back to the Git root. Explicit nested projects continue to override configured ancestors.

## Filesystem safety and errors

Before deletion, every target is resolved from fixed path segments beneath the canonical project root. No user-controlled relative deletion path, wildcard, or unresolved environment variable is accepted.

All ancestors above a deletion target must be real directories inside the canonical project root. A symbolic-link ancestor or a non-directory ancestor produces `storage.integrity_error` before deletion begins.

The final target may itself be a symbolic link. In that case, the command unlinks only the symbolic link and never follows it:

- a symlinked `config.yaml` is unlinked without touching its destination;
- a symlinked `ai-qa-project` entry is unlinked without touching its destination;
- in `--records` mode, a symlinked `.ai-qa` entry is unlinked without touching its destination.

Real directory targets are removed recursively only for the two exact, validated directory paths described above. Unexpected filesystem failures are reported as errors; the command never reports a failed deletion as successful.

The service preflights the complete deletion set before making changes. This prevents predictable integrity failures on a later target from causing a partial clear. Cross-directory deletion cannot be made fully atomic. Once a target has been renamed into a project-local removal claim, any inspection, removal, hook, or cleanup failure recomputes the recovery location from the claim's current structure, returns `storage.recovery_required` with that project-relative `recoveryPath`, and retains the claim when it still exists. Every later clear preflight fails with the same recovery-required contract while a reserved claim remains. If the claim itself has unexpectedly disappeared, the operation instead fails with `storage.integrity_error` and no `recoveryPath`; because there is then no retained object to recover, a later invocation follows normal missing-target idempotency. The command never automatically deletes, restores, or resumes retained claims; an operator must inspect and manually resolve the reported recovery entry before running clear again.

## Testing

Service and CLI tests cover:

- default clear removes config and the entire Project Skill directory;
- default clear preserves cases, runs, run groups, evidence, reports, receipts, and other `.ai-qa` content;
- `--records` removes the entire `.ai-qa` directory and the entire Project Skill directory;
- unrelated skills under `.agents/skills/` remain intact;
- `--project` selects an exact nested project even when an ancestor is initialized;
- implicit discovery uses the configured ancestor first and Git root as the repeat-run fallback;
- missing deletion targets produce a successful result with an empty or partial `removedPaths` list;
- repeated default and `--records` invocations succeed;
- symbolic-link targets are unlinked without modifying their destinations;
- symbolic-link or invalid ancestors fail with `storage.integrity_error` and do not affect outside data;
- post-claim failures retain their recovery entry and block retries with `storage.recovery_required` until it is manually resolved;
- help text documents `clear` and `--records`;
- successful JSON output matches the public contract.

The existing full TypeScript/Node quality gate remains required after implementation.

## Out of scope

- interactive confirmation;
- backups, trash, or recovery archives;
- selectively clearing individual record categories;
- clearing global managed skills or other project skills;
- deleting the target project itself or unrelated project files.
