# Multi-Platform Live Acceptance

This gate proves user-selected platform subsets, RunGroup immutability, aggregate matrices, coverage gaps, and group recording. Complete the individual Web, iOS Simulator, and Android Emulator gates first.

## Two-platform selection

1. Configure all three platforms, then explicitly select only iOS Simulator and Android Emulator for `run-group start`.
2. Supply ready doctor results only for that selected subset. Verify the frozen manifest contains two selected platforms and no Web child run.
3. Complete each child regression with its configured controller, fresh evidence chain, terminal verdict, and verified report.
4. Finish the group; generate/export the aggregate report. Verify exactly two cells in canonical selected-platform order and no aggregate verdict.

## Three-platform selection and exclusions

1. Start a second RunGroup with explicit Web, iOS Simulator, and Android Emulator selection and at least one fully variant-backed case.
2. Include a case missing one selected platform variant. Verify the manifest creates no child for that cell and records `missing_variant`.
3. Complete every materialized child and generate its verified report; finish the group.
4. Generate/export the aggregate report. Verify one immutable cell per selected case/platform pair, including `coverage_gap` for the missing variant, exact summary counts, stable ordering, and no synthesized QA verdict.
5. Verify `report group-recording-status`. For project-skill mode, run the exact frozen procedure once and submit `report group-receipt`; verify replay idempotency and unchanged child/aggregate content.

## Required proof

- Two distinct group IDs, frozen platform selections, child run IDs, exclusions, budgets, and terminal group events.
- All child report paths/hashes and both aggregate JSON/Markdown pairs.
- Matrix cells and summary counts showing the two-platform exclusion of Web and the three-platform coverage gap.
- Group recording status/receipt and proof that recording did not create a QA verdict or alter matrix cells.
