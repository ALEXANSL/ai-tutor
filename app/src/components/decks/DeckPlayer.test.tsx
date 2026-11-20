// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DeckPlayer } from "./DeckPlayer";

vi.mock("@/components/child/pdfEngine", () => ({
  loadPdfDocument: async () => ({}),
  renderPdfPage: async () => {},
  isRenderCancelledError: () => false,
}));

it("replaces the current slide and narration for next, previous, jump and automatic advance", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const container = document.createElement("div");
  const root = createRoot(container);
  function checkSlide(number: number) {
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(container.querySelector("canvas")?.getAttribute("aria-label")).toBe(`Слайд ${number}`);
    expect(container.querySelectorAll("audio")).toHaveLength(1);
    expect(container.querySelector("audio")?.getAttribute("src")).toBe(`/api/presentations/deck/${number}.mp3`);
  }
  try {
    await act(async () => root.render(<DeckPlayer id="deck" scripts={["А", "Б", "В", "Г"]} />));
    const [previous, next] = container.querySelectorAll("nav button");
    checkSlide(1);
    await act(async () => (next as HTMLButtonElement).click());
    checkSlide(2);
    await act(async () => (previous as HTMLButtonElement).click());
    checkSlide(1);
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    checkSlide(3);
    await act(async () => container.querySelector("audio")!.dispatchEvent(new Event("ended")));
    checkSlide(4);
    expect((next as HTMLButtonElement).disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
