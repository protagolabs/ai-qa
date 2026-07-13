export interface AgentCapabilityObservation {
  status: "ready" | "missing" | "unknown";
  observedAt: string;
  evidence: string;
}

export interface DoctorCheck {
  code:
    | "web.entry_url"
    | "web.entry_page"
    | "web.readiness_url"
    | "web.chrome_devtools_mcp"
    | "agent.global_skill";
  status: "pass" | "fail" | "agent_confirmation_required";
  message: string;
}

export interface WebDoctorResult {
  platform: "web";
  status: "ready" | "not_ready";
  checks: DoctorCheck[];
}

export interface WebDoctorInput {
  entryUrl: string;
  readinessUrl?: string;
  entryPage?: AgentCapabilityObservation;
  chromeDevtoolsMcp: AgentCapabilityObservation;
  globalSkillStatus: "compatible" | "missing" | "stale" | "conflict";
  fetchImpl: typeof fetch;
}

export async function runWebDoctor(
  input: WebDoctorInput,
): Promise<WebDoctorResult> {
  const checks: DoctorCheck[] = [
    {
      code: "web.entry_url",
      status: "pass",
      message: `Configured ${input.entryUrl}`,
    },
  ];
  if (input.readinessUrl !== undefined) {
    try {
      const response = await input.fetchImpl(input.readinessUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      checks.push({
        code: "web.readiness_url",
        status: response.ok ? "pass" : "fail",
        message: `HTTP ${response.status}`,
      });
    } catch (error: unknown) {
      checks.push({
        code: "web.readiness_url",
        status: "fail",
        message: String(error),
      });
    }
  } else {
    const entryPage = input.entryPage ?? {
      status: "unknown" as const,
      observedAt: new Date(0).toISOString(),
      evidence: "No readiness URL or agent entry-page observation was supplied",
    };
    checks.push({
      code: "web.entry_page",
      status:
        entryPage.status === "ready"
          ? "pass"
          : entryPage.status === "missing"
            ? "fail"
            : "agent_confirmation_required",
      message: entryPage.evidence,
    });
  }
  checks.push({
    code: "web.chrome_devtools_mcp",
    status:
      input.chromeDevtoolsMcp.status === "ready"
        ? "pass"
        : input.chromeDevtoolsMcp.status === "missing"
          ? "fail"
          : "agent_confirmation_required",
    message: input.chromeDevtoolsMcp.evidence,
  });
  checks.push({
    code: "agent.global_skill",
    status: input.globalSkillStatus === "compatible" ? "pass" : "fail",
    message: `Global skill status: ${input.globalSkillStatus}`,
  });
  return {
    platform: "web",
    status: checks.every((check) => check.status === "pass")
      ? "ready"
      : "not_ready",
    checks,
  };
}
