import { describe, expect, it } from "vitest";
import { parseEmailList, resolveRole } from "./allowlist";

// Placeholder addresses only — real allowlist e-mails live in env vars (US-1.1 KP-3).
const lists = {
  parent: parseEmailList(" Parent.Placeholder@example.com ,other-parent@example.com"),
  child: parseEmailList("child.placeholder@example.com"),
};

describe("parseEmailList", () => {
  it("splits on commas, semicolons, whitespace and newlines, lowercases and dedupes", () => {
    expect(parseEmailList("A@example.com; b@example.com\nc@example.com  a@EXAMPLE.com,")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });
  it("returns [] for empty/undefined and drops garbage", () => {
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList("")).toEqual([]);
    expect(parseEmailList("not-an-email, ,")).toEqual([]);
  });
});

describe("resolveRole (US-1.1 KP-1, KP-2)", () => {
  it("maps listed parent and child e-mails to roles, case-insensitively", () => {
    expect(resolveRole("parent.placeholder@EXAMPLE.com", lists)).toEqual({ ok: true, role: "parent" });
    expect(resolveRole("  child.placeholder@example.com ", lists)).toEqual({ ok: true, role: "child" });
  });
  it("denies e-mails that are not listed", () => {
    expect(resolveRole("stranger@example.com", lists)).toEqual({ ok: false, reason: "not_listed" });
  });
  it("denies when there is no e-mail", () => {
    expect(resolveRole(undefined, lists)).toEqual({ ok: false, reason: "no_email" });
    expect(resolveRole("", lists)).toEqual({ ok: false, reason: "no_email" });
  });
  it("denies everyone when the allowlist is not configured", () => {
    expect(resolveRole("parent.placeholder@example.com", { parent: [], child: [] })).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });
  it("denies an account present in both lists instead of guessing the role", () => {
    const both = { parent: ["same@example.com"], child: ["same@example.com"] };
    expect(resolveRole("same@example.com", both)).toEqual({ ok: false, reason: "ambiguous" });
  });
  it("does not treat Gmail dot/plus variants as the same account", () => {
    expect(resolveRole("parentplaceholder@example.com", lists).ok).toBe(false);
    expect(resolveRole("parent.placeholder+x@example.com", lists).ok).toBe(false);
  });
});
