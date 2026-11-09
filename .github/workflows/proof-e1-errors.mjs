import { appendFileSync } from "node:fs";

// Observe native assertion data; never modify a task, result, or test value.
export default class CompletionErrors {
  onTestCaseResult(testCase) {
    const result = testCase.result();
    if (result.state !== "failed") {
      return;
    }
    appendFileSync(
      process.env.E1_BASELINE_ERRORS,
      `${JSON.stringify({
        name: testCase.name,
        state: result.state,
        errors: result.errors.map(({ name, message, stack, actual, expected, diff }) => ({
          name,
          message,
          stack,
          actual,
          expected,
          diff,
        })),
      })}\n`,
    );
  }
}
