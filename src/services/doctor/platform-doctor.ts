import type { ProjectConfigV3 } from "../../core/config/schema.js";
import type { Platform } from "../../core/platforms/schema.js";
import {
  platformReadinessSchema,
  type AgentCapabilityObservation,
  type PlatformReadiness,
} from "../../core/readiness/schema.js";
import type { InstallationCheck } from "./installation-doctor.js";

const PLATFORM_CHECKS = {
  web: [
    "web.entry_url",
    "web.entry_page",
    "web.readiness_url",
    "web.chrome_devtools_mcp",
  ],
  "ios-simulator": ["ios.simulator", "ios.app", "ios.pepper"],
  "android-emulator": [
    "android.emulator",
    "android.app",
    "android.appium",
    "android.uiautomator2",
  ],
} as const satisfies Record<Platform, readonly string[]>;

type ConfiguredTarget<P extends Platform> = NonNullable<
  ProjectConfigV3["targets"][P]
>;
type ConfiguredTool<P extends Platform> = NonNullable<
  ProjectConfigV3["tools"][P]
>;

interface PlatformDoctorBase {
  installationChecks: readonly InstallationCheck[];
  fetchImpl: typeof fetch;
}

export type PlatformDoctorInput = PlatformDoctorBase &
  (
    | {
        platform: "web";
        target: ConfiguredTarget<"web">;
        observations: {
          entryPage?: AgentCapabilityObservation;
          chromeDevtoolsMcp: AgentCapabilityObservation;
        };
      }
    | {
        platform: "ios-simulator";
        target: ConfiguredTarget<"ios-simulator">;
        observations: {
          simulator: AgentCapabilityObservation;
          app: AgentCapabilityObservation;
          pepper: AgentCapabilityObservation;
        };
      }
    | {
        platform: "android-emulator";
        target: ConfiguredTarget<"android-emulator">;
        tool: ConfiguredTool<"android-emulator">;
        observations: {
          emulator: AgentCapabilityObservation;
          app: AgentCapabilityObservation;
          appium: AgentCapabilityObservation;
          uiautomator2: AgentCapabilityObservation;
        };
      }
  );

type ReadinessCheck = PlatformReadiness["checks"][number];

export async function runPlatformDoctor(
  input: PlatformDoctorInput,
): Promise<PlatformReadiness> {
  const checks = installationChecks(input.installationChecks);

  switch (input.platform) {
    case "web":
      await appendWebChecks(checks, input);
      break;
    case "ios-simulator":
      checks.push(
        observationCheck(
          PLATFORM_CHECKS["ios-simulator"][0],
          "environment",
          input.observations.simulator,
        ),
        observationCheck(
          PLATFORM_CHECKS["ios-simulator"][1],
          "environment",
          input.observations.app,
        ),
        observationCheck(
          PLATFORM_CHECKS["ios-simulator"][2],
          "tool",
          input.observations.pepper,
        ),
      );
      break;
    case "android-emulator":
      checks.push(
        observationCheck(
          PLATFORM_CHECKS["android-emulator"][0],
          "environment",
          input.observations.emulator,
        ),
        observationCheck(
          PLATFORM_CHECKS["android-emulator"][1],
          "environment",
          input.observations.app,
        ),
        observationCheck(
          PLATFORM_CHECKS["android-emulator"][2],
          "tool",
          input.observations.appium,
        ),
        observationCheck(
          PLATFORM_CHECKS["android-emulator"][3],
          "tool",
          input.observations.uiautomator2,
        ),
      );
      break;
  }

  return platformReadinessSchema.parse({
    platform: input.platform,
    status: checks.every((check) => check.status === "pass")
      ? "ready"
      : "not_ready",
    checks,
  });
}

function installationChecks(
  checks: readonly InstallationCheck[],
): ReadinessCheck[] {
  return checks.map((check): ReadinessCheck => ({
    code: check.code,
    status:
      check.status === "pass" || check.status === "advisory" ? "pass" : "fail",
    message: check.message,
    category: "installation",
  }));
}

async function appendWebChecks(
  checks: ReadinessCheck[],
  input: Extract<PlatformDoctorInput, { platform: "web" }>,
): Promise<void> {
  checks.push({
    code: PLATFORM_CHECKS.web[0],
    status: "pass",
    message: `Configured ${input.target.entryUrl}`,
    category: "environment",
  });

  if (input.target.readinessUrl !== undefined) {
    try {
      const response = await input.fetchImpl(input.target.readinessUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      checks.push({
        code: PLATFORM_CHECKS.web[2],
        status: response.ok ? "pass" : "fail",
        message: `HTTP ${response.status}`,
        category: "environment",
      });
    } catch (error: unknown) {
      checks.push({
        code: PLATFORM_CHECKS.web[2],
        status: "fail",
        message: String(error),
        category: "environment",
      });
    }
  } else {
    const entryPage = input.observations.entryPage ?? {
      status: "unknown" as const,
      observedAt: new Date(0).toISOString(),
      evidence: "No readiness URL or agent entry-page observation was supplied",
    };
    checks.push(
      observationCheck(PLATFORM_CHECKS.web[1], "environment", entryPage),
    );
  }

  checks.push(
    observationCheck(
      PLATFORM_CHECKS.web[3],
      "tool",
      input.observations.chromeDevtoolsMcp,
    ),
  );
}

function observationCheck(
  code: string,
  category: "tool" | "environment",
  observation: AgentCapabilityObservation,
): ReadinessCheck {
  return {
    code,
    status:
      observation.status === "ready"
        ? "pass"
        : observation.status === "missing"
          ? "fail"
          : "agent_confirmation_required",
    message: observation.evidence,
    category,
  };
}
