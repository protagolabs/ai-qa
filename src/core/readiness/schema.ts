import { z } from "zod";
import { platformSchema } from "../platforms/schema.js";

export const agentCapabilityObservationSchema = z
  .object({
    status: z.enum(["ready", "missing", "unknown"]),
    observedAt: z.string().datetime(),
    evidence: z.string().trim().min(1),
  })
  .strict();

const webPlatformDoctorInputSchema = z
  .object({
    platform: z.literal("web"),
    entryPage: agentCapabilityObservationSchema.optional(),
    chromeDevtoolsMcp: agentCapabilityObservationSchema,
  })
  .strict();

const iosPlatformDoctorInputSchema = z
  .object({
    platform: z.literal("ios-simulator"),
    simulator: agentCapabilityObservationSchema,
    app: agentCapabilityObservationSchema,
    pepper: agentCapabilityObservationSchema,
  })
  .strict();

const androidPlatformDoctorInputSchema = z
  .object({
    platform: z.literal("android-emulator"),
    emulator: agentCapabilityObservationSchema,
    app: agentCapabilityObservationSchema,
    appium: agentCapabilityObservationSchema,
    uiautomator2: agentCapabilityObservationSchema,
  })
  .strict();

export const platformDoctorInputSchema = z.discriminatedUnion("platform", [
  webPlatformDoctorInputSchema,
  iosPlatformDoctorInputSchema,
  androidPlatformDoctorInputSchema,
]);

export const platformReadinessSchema = z
  .object({
    platform: platformSchema,
    status: z.enum(["ready", "not_ready"]),
    checks: z.array(
      z
        .object({
          code: z.string().trim().min(1),
          status: z.enum(["pass", "fail", "agent_confirmation_required"]),
          message: z.string().trim().min(1),
          category: z.enum(["installation", "tool", "environment"]),
        })
        .strict(),
    ),
  })
  .strict();

export type AgentCapabilityObservation = z.infer<
  typeof agentCapabilityObservationSchema
>;
export type PlatformDoctorObservationInput = z.infer<
  typeof platformDoctorInputSchema
>;
export type PlatformReadiness = z.infer<typeof platformReadinessSchema>;
