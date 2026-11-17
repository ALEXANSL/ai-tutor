import { expect, it } from "vitest";
import { homeworkVisualSvg } from "./homework-visual";
import { homeworkVisualSchema } from "./homework";
it("supports signed data with a zero axis and escapes all source labels", () => {
  const visual = homeworkVisualSchema.parse({ kind: "chart", title: '<script>alert("x")</script>', caption: "Температури з умови", unit: "°C", items: [{ label: "День 1", detail: "", value: -5 }, { label: "День 2", detail: "", value: 10 }] });
  const svg = homeworkVisualSvg(visual); expect(svg).not.toContain("<script>"); expect(svg).toContain("&lt;script&gt;"); expect(svg).toContain("-5 °C"); expect(svg).not.toMatch(/width="-/);
});
