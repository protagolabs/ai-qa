import type {
  AssertionPayload,
  DecisionPayload,
  ObservationPayload,
  RecoveryPayload,
} from "../../src/core/runs/event-payloads.js";
import {
  RunProtocolService as SessionRunProtocolService,
  type CompleteActionInput,
  type PlanActionInput,
} from "../../src/services/run-protocol/run-protocol-service.js";

/**
 * Event-only adapter for pre-RunSession test fixtures. Production callers use
 * the full ProtocolCommandResult; these fixtures remain focused on event data.
 */
export class RunProtocolService {
  private readonly service: SessionRunProtocolService;

  constructor(projectRoot: string, runId: string, now: () => Date) {
    this.service = new SessionRunProtocolService(projectRoot, runId, now);
  }

  async planAction(input: PlanActionInput) {
    return (await this.service.planAction(input)).event;
  }

  async completeAction(input: CompleteActionInput) {
    return (await this.service.completeAction(input)).event;
  }

  async addObservation(input: ObservationPayload) {
    return (await this.service.addObservation(input)).event;
  }

  async recordAssertion(input: AssertionPayload) {
    return (await this.service.recordAssertion(input)).event;
  }

  async recordDecision(input: DecisionPayload) {
    return (await this.service.recordDecision(input)).event;
  }

  async resolveUnknownAction(input: RecoveryPayload) {
    return (await this.service.resolveUnknownAction(input)).event;
  }
}
