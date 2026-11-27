import { expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import sharp from "sharp";
import { renderPlaceMap, validPlaces } from "./maps";

it("draws a text-free map and returns where each named place lands", async () => {
  const { bytes, labels } = await renderPlaceMap([{ name: "Афіни", lat: 37.98, lon: 23.73 }, { name: "Крит", lat: 35.24, lon: 24.9 }]);
  expect((await sharp(bytes).metadata()).format).toBe("jpeg");
  expect(labels.map(l => l.name)).toEqual(["Афіни", "Крит"]);
  for (const l of labels) { expect(l.x).toBeGreaterThan(0.05); expect(l.x).toBeLessThan(0.95); expect(l.y).toBeGreaterThan(0.05); expect(l.y).toBeLessThan(0.95); }
  // Athens is north of Crete.
  expect(labels[0]!.y).toBeLessThan(labels[1]!.y);
});

it("drops places without a name or with impossible coordinates", () => {
  expect(validPlaces([{ name: " ", lat: 1, lon: 1 }, { name: "X", lat: 95, lon: 0 }, { name: "Гіза", lat: 29.98, lon: 31.13 }])).toEqual([{ name: "Гіза", lat: 29.98, lon: 31.13 }]);
});
