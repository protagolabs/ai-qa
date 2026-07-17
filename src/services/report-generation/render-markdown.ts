import type { RunReport } from "../../core/reports/schema.js";

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function text(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(code).join(", ");
}

export function renderRunReportMarkdown(report: RunReport): string {
  const criteria =
    report.verdict.criterionResults.length === 0
      ? "None."
      : report.verdict.criterionResults
          .map((result) => {
            const criterion = report.workOrder.acceptanceCriteria.find(
              (candidate) => candidate.id === result.criterionId,
            );
            return `- ${code(result.criterionId)} ${text(criterion?.description ?? "")}: **${result.status}**\n  - Required proof: ${list(criterion?.requiredEvidence ?? [])}\n  - Assertions: ${list(result.assertionIds)}\n  - Evidence: ${list(result.evidenceIds)}`;
          })
          .join("\n");
  const evidence =
    report.evidence.length === 0
      ? "None."
      : report.evidence
          .map(
            (item) =>
              `- ${code(item.id)} — source-tool ${code(item.sourceTool)} — ${list(item.evidenceKinds)} — ${code(item.contentHash)} — ${code(item.path)}`,
          )
          .join("\n");
  const timeline =
    report.timeline.length === 0
      ? "None."
      : report.timeline
          .map(
            (event) =>
              `${event.sequence}. ${code(event.type)} ${code(event.eventId)} — ${text(event.summary)}`,
          )
          .join("\n");
  const pinned = report.workOrder.pinnedCase;
  const pinnedMetadata =
    pinned === undefined
      ? ""
      : `- Case: ${code(pinned.caseId)} revision ${pinned.revision}\n- Case hash: ${code(pinned.caseContentHash)}\n- Platform variant hash: ${code(pinned.platformVariantHash)}\n`;

  return `# AI QA Run ${report.run.id}\n\n- Project: ${text(report.project.name)} (${code(report.project.id)})\n- Audience: ${text(report.reportPolicy.audience)}\n- Detail: ${code(report.reportPolicy.detail)}\n- Platform: ${code(report.run.platform)}\n- Controller: ${code(report.run.controller)}\n- Kind: ${code(report.run.kind)}\n- Status: ${code(report.run.status)}\n- Verdict: ${code(report.verdict.classification)}\n- Screenshot policy: ${code(report.workOrder.evidencePolicy.screenshots)}\n- Generated: ${report.generatedAt}\n${pinnedMetadata}\n## Goal\n\n${text(report.workOrder.goal)}\n\n## Summary\n\n${text(report.verdict.summary)}\n\n## Acceptance Criteria\n\n${criteria}\n\n## Evidence\n\n${evidence}\n\n## Timeline\n\n${timeline}\n\n## Integrity\n\nVerified at ${report.integrity.verifiedAt}.\n`;
}
