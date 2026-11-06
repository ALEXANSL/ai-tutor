import { afterEach, expect, it, vi } from "vitest";
import { AiNotConfiguredError, BudgetBlockedError, ProviderError } from "@/server/ai/types";
import { explanationErrorMessage, ExplanationUnavailableError } from "./explanationError";

afterEach(() => vi.restoreAllMocks());

it.each([
  [new BudgetBlockedError("hard_stop", "tutor_chat"), "EXPLAIN-BUDGET"],
  [new BudgetBlockedError("deferred", "tutor_chat"), "EXPLAIN-DEFERRED"],
  [new AiNotConfiguredError("private payload"), "EXPLAIN-CONFIG"],
  [new ProviderError("private payload", "openai", 401, false), "EXPLAIN-HTTP-401"],
  [new ProviderError("private payload", "openai", 429, true), "EXPLAIN-HTTP-429"],
  [new ProviderError("private payload", "anthropic", null, true), "EXPLAIN-CONNECTION"],
  [new Error("private payload"), "EXPLAIN-UNKNOWN"],
])("classifies a failure without exposing error bodies (%s)", (error, code) => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const message = explanationErrorMessage(error);
  expect(message).toContain(code);
  expect(message).not.toContain("private payload");
  expect(JSON.stringify(log.mock.calls)).not.toContain("private payload");
});

it("does not replace a known category when an action catches it", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new ExplanationUnavailableError(new BudgetBlockedError("hard_stop", "tutor_chat"));
  expect(explanationErrorMessage(error)).toBe(error.message);
  expect(log).toHaveBeenCalledOnce();
});
