import { expect, it, vi } from "vitest";
vi.mock("@serwist/next", () => ({ default: () => (config: unknown) => config }));
import nextConfig from "../next.config";
it("keeps microphone policy valid when a single app document navigates from home/login to a lesson or friend", async () => {
  const rules = await nextConfig.headers!();
  const policies = rules.flatMap(rule => rule.headers.filter(header => header.key.toLowerCase() === "permissions-policy").map(header => ({ source: rule.source, value: header.value })));
  expect(policies.find(rule => rule.source === "/:path*")?.value).toContain("microphone=(self)");
  expect(policies.some(rule => /microphone=\(\)/.test(rule.value))).toBe(false);
  expect(policies.every(rule => rule.value.includes("camera=()") && rule.value.includes("geolocation=()"))).toBe(true);
  expect(policies.some(rule => /microphone=\*/.test(rule.value))).toBe(false);
});
