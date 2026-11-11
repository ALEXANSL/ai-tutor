import { expect, it } from "vitest";
import { documentAllowsMicrophone } from "./microphonePolicy";
it("checks modern and Chrome legacy document policy, independently of the current pathname", () => {
  expect(documentAllowsMicrophone({ permissionsPolicy: { allowsFeature: () => false } } as unknown as Document)).toBe(false);
  expect(documentAllowsMicrophone({ featurePolicy: { allowsFeature: () => true } } as unknown as Document)).toBe(true);
});
it("does not invent a permission denial in browsers without policy introspection", () => {
  expect(documentAllowsMicrophone({} as Document)).toBeUndefined();
  expect(documentAllowsMicrophone({ permissionsPolicy: { allowsFeature: () => { throw Error("unsupported"); } } } as unknown as Document)).toBeUndefined();
});
