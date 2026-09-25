import { describe, expect, it } from "vitest";
import { uk } from "@/i18n/uk";
import { pinSaveErrorMessage } from "./pin-errors";

/** BUG-005: "unavailable" must map to a specific, actionable message. */
describe("pinSaveErrorMessage", () => {
  it("maps mismatch/format to their own messages", () => {
    expect(pinSaveErrorMessage("mismatch")).toBe(uk.parent.settings.pinMismatch);
    expect(pinSaveErrorMessage("format")).toBe(uk.parent.settings.pinFormat);
  });

  it("maps 'unavailable' to a concrete PIN_PEPPER explanation, not a generic error", () => {
    const message = pinSaveErrorMessage("unavailable");
    expect(message).not.toBe(uk.common.error);
    expect(message).toContain("PIN_PEPPER");
    expect(message).toContain("app/README.md");
  });
});
