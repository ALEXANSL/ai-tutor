import { afterEach, describe, expect, it, vi } from "vitest";

const expire = vi.fn(async () => {});
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/server/auth/guards", () => ({ requireUser: vi.fn() }));
vi.mock("@/server/auth/parent-mode", () => ({
  clearParentMode: vi.fn(),
  enterParentMode: vi.fn(),
  touchParentMode: vi.fn(),
  expireParentModeSilently: expire,
}));

const { endParentModeSilentlyAction } = await import("./parent-mode");

afterEach(() => {
  expire.mockClear();
  delete process.env.PARENT_MODE_AUTO_EXIT;
});

describe("endParentModeSilentlyAction (D-140)", () => {
  it("keeps parent mode when auto-exit is off, even if an old child page calls it", async () => {
    await endParentModeSilentlyAction();
    expect(expire).not.toHaveBeenCalled();
  });

  it("still ends parent mode when PARENT_MODE_AUTO_EXIT=1", async () => {
    process.env.PARENT_MODE_AUTO_EXIT = "1";
    await endParentModeSilentlyAction();
    expect(expire).toHaveBeenCalledOnce();
  });
});
