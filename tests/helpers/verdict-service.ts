import type {
  BlockerPayload,
  VerdictPayload,
} from "../../src/core/verdicts/schema.js";
import { VerdictService as SessionVerdictService } from "../../src/services/run-protocol/verdict-service.js";

/** Event-only adapter for fixtures that predate ProtocolCommandResult. */
export class VerdictService {
  private readonly service: SessionVerdictService;

  constructor(projectRoot: string, runId: string, now: () => Date) {
    this.service = new SessionVerdictService(projectRoot, runId, now);
  }

  async recordBlocker(input: BlockerPayload) {
    return (await this.service.recordBlocker(input)).event;
  }

  async set(input: VerdictPayload) {
    return (await this.service.set(input)).event;
  }

  async revise(input: VerdictPayload & { supersedes: string }) {
    return (await this.service.revise(input)).event;
  }

  effectiveVerdict() {
    return this.service.effectiveVerdict();
  }

  async recordCancellation(reason: string) {
    return (await this.service.recordCancellation(reason)).event;
  }
}
