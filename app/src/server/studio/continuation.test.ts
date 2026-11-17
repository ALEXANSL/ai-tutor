import { expect, it, vi } from "vitest";
import { studioProjectFixture } from "./__fixtures__/project";
const f = vi.hoisted(() => ({ register: vi.fn(), kick: vi.fn() }));
vi.mock("@/server/jobs/runner", () => ({ registerJobHandler: f.register }));
vi.mock("./store", () => ({ STUDIO_STEP: "studio.step", readStudioProject: async () => studioProjectFixture() }));
vi.mock("./wake", () => ({ kickStudio: f.kick }));
import { registerStudioJobs } from "./workflow";
it("hands a generic-worker time-budget requeue to the project continuation without requiring the page to be open", async () => {
  registerStudioJobs(); const handler = f.register.mock.calls[0]![1];
  const id = "11111111-1111-4111-8111-111111111111";
  const outcome = await handler.run({ family_id: "family", payload: { projectId: id, token: studioProjectFixture().token } }, { deadline: Date.now() + 10000 });
  expect(outcome.requeue).toBe(true); expect(f.kick).toHaveBeenCalledWith("family", id);
});
