import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PARENT_MODE_MANUAL_MINUTES, parentModeAutoExit, parentModeMinutes } from "./parent-mode-policy";

afterEach(() => { vi.unstubAllEnvs(); });

it("keeps parent mode until the explicit exit by default (D-140)", () => {
  expect(parentModeAutoExit()).toBe(false);
  expect(parentModeMinutes(5)).toBe(PARENT_MODE_MANUAL_MINUTES);
});

it("brings back the idle timeout with PARENT_MODE_AUTO_EXIT=1", () => {
  vi.stubEnv("PARENT_MODE_AUTO_EXIT", "1");
  expect(parentModeAutoExit()).toBe(true);
  expect(parentModeMinutes(5)).toBe(5);
});
