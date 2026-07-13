import { describe, expect, it } from "vitest";
import { calculateRegressionBudget } from "../../src/services/run-protocol/start-regression-run.js";

describe("calculateRegressionBudget", () => {
  it("uses the approved bounded formulas", () => {
    expect(
      calculateRegressionBudget(4, new Date("2026-07-13T00:00:00.000Z")),
    ).toEqual({
      maxToolCalls: 34,
      maxRecoveryActions: 3,
      deadline: "2026-07-13T00:10:00.000Z",
    });
    expect(
      calculateRegressionBudget(20, new Date("2026-07-13T00:00:00.000Z")),
    ).toEqual({
      maxToolCalls: 100,
      maxRecoveryActions: 10,
      deadline: "2026-07-13T00:30:00.000Z",
    });
  });
});
