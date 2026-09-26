import { describe, expect, it } from "vitest";
import { personaWordlists } from "@/lib/persona/wordlists";
import { validateTutorName } from "@/lib/persona/validation";
import { isFlagged, isUrgent } from "./classify";
import { REDLINE_TESTSET, REDLINE_TUTOR_NAMES } from "./testset";

/**
 * The regression set itself (backlog S4: "секрети від тата, страх/смуток,
 * небезпечні дії, «ти людина?», jailbreak, персональні дані, прохання про
 * Robux/нагороди"). This file checks the set's own completeness and that our
 * PURE code (isFlagged/isUrgent, the wordlist validator) reacts correctly to
 * each expected verdict — it does not call any model (see
 * `scripts/safety-manual-run.ts` for that). `moderate.test.ts` already
 * covers the two-layer merge logic with mocked provider responses.
 */
const REQUIRED_GROUPS = [
  "secret_from_parent",
  "fear_sadness",
  "self_harm",
  "dangerous_act",
  "violence",
  "stranger_contact",
  "am_i_human",
  "jailbreak",
  "personal_data",
  "reward_request",
] as const;

describe("REDLINE_TESTSET completeness (backlog S4 regression set)", () => {
  it("covers every required red-line group at least once", () => {
    const groups = new Set(REDLINE_TESTSET.map((c) => c.group));
    for (const g of REQUIRED_GROUPS) expect(groups.has(g)).toBe(true);
  });
  it("has at least one benign control phrase (must NOT trigger anything)", () => {
    expect(REDLINE_TESTSET.some((c) => c.group === "benign_control")).toBe(true);
  });
  it("every case id is unique", () => {
    const ids = REDLINE_TESTSET.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("100 % of urgent-group cases expect severity=urgent (and only those)", () => {
  const URGENT_GROUPS = new Set(["self_harm", "dangerous_act", "violence", "stranger_contact"]);
  it.each(REDLINE_TESTSET)("$id ($group)", (c) => {
    if (URGENT_GROUPS.has(c.group)) {
      expect(c.expectedSeverity).toBe("urgent");
      expect(isUrgent({ severity: c.expectedSeverity })).toBe(true);
    } else if (c.group === "benign_control" || c.group === "am_i_human") {
      expect(c.expectedSeverity).toBe("none");
      expect(isFlagged({ category: c.expectedCategory, severity: c.expectedSeverity })).toBe(false);
    } else {
      expect(c.expectedSeverity).toBe("normal");
      expect(isFlagged({ category: c.expectedCategory, severity: c.expectedSeverity })).toBe(true);
    }
  });
});

describe("REDLINE_TUTOR_NAMES: 100 % of kinship/inappropriate names rejected by the wordlist (NFR-SAFE-14)", () => {
  it.each(REDLINE_TUTOR_NAMES)("$id: $name -> shouldReject=$shouldReject", (c) => {
    const result = validateTutorName(c.name, { wordlists: personaWordlists });
    if (c.reason === "kinship") expect(result).toMatchObject({ ok: false, error: "kinship" });
    else if (c.reason === "inappropriate") expect(result).toMatchObject({ ok: false, error: "inappropriate" });
    else if (c.reason === "ok") expect(result.ok).toBe(true);
  });
});
