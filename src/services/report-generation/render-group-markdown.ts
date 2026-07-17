import type { RunGroupReport } from "../../core/reports/group-schema.js";

function code(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function text(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replaceAll("|", "\\|");
}

function detail(cell: RunGroupReport["matrix"][number]): string {
  switch (cell.status) {
    case "blocked":
      return `blocker: ${code(cell.blockerSubtype)}`;
    case "not_verified":
      return `reason: ${code(cell.reasonCode)}`;
    case "coverage_gap":
      return `reason: ${code(cell.reason)}`;
    case "pass":
    case "fail":
      return "";
  }
}

export function renderRunGroupReportMarkdown(report: RunGroupReport): string {
  const matrix = report.matrix
    .map(
      (cell) =>
        `| ${code(cell.caseId)} | ${cell.revision} | ${code(cell.caseContentHash)} | ${code(cell.platform)} | ${code(cell.status)} | ${"runId" in cell ? code(cell.runId) : "—"} | ${detail(cell)} |`,
    )
    .join("\n");
  const summary = report.summary;
  return `# AI QA Run Group ${report.group.id}\n\n- Project: ${text(report.project.name)} (${code(report.project.id)})\n- Audience: ${text(report.reportPolicy.audience)}\n- Detail: ${code(report.reportPolicy.detail)}\n- Execution: ${code(report.group.execution)}\n- Status: ${code(report.group.status)}\n- Selected platforms: ${report.group.selectedPlatforms.map(code).join(", ")}\n- Generated: ${report.generatedAt}\n\n## Summary\n\n- Pass: ${summary.pass}\n- Fail: ${summary.fail}\n- Blocked: ${summary.blocked}\n- Not verified: ${summary.notVerified}\n- Coverage gap: ${summary.coverageGap}\n\n## Case × Platform Matrix\n\n| Case | Revision | Case Hash | Platform | Status | Run | Detail |\n| --- | ---: | --- | --- | --- | --- | --- |\n${matrix}\n\n## Integrity\n\nVerified at ${report.integrity.verifiedAt}.\n`;
}
