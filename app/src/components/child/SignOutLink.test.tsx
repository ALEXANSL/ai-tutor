import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutLink } from "./SignOutLink";

/** BUG-004 (b): an unobtrusive sign-out entry, not a prominent button. */
describe("SignOutLink", () => {
  it("renders only a quiet text link initially, no visible confirmation form", () => {
    const html = renderToStaticMarkup(<SignOutLink />);
    expect(html).toContain("Вийти з акаунта");
    expect(html).not.toContain("/auth/signout");
    expect(html).not.toContain("Точно вийти");
  });
});
