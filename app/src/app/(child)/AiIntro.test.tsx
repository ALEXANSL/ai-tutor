import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AiIntro } from "./AiIntro";

/** BUG-002 / US-12.3 KP-1: the honest intro agrees with the tutor's gender. */
describe("AiIntro", () => {
  it("says 'ШІ-помічник' for a male tutor", () => {
    const html = renderToStaticMarkup(<AiIntro nickname="Зірочка" tutorName="Остап" gender="m" />);
    expect(html).toContain("Я — Остап");
    expect(html).toContain("Я — ШІ-помічник, не людина.");
    expect(html).not.toContain("ШІ-помічниця");
  });
  it("says 'ШІ-помічниця' for a female tutor", () => {
    const html = renderToStaticMarkup(<AiIntro nickname="Зірочка" tutorName="Ліра" gender="f" />);
    expect(html).toContain("Я — ШІ-помічниця, не людина.");
  });
});
