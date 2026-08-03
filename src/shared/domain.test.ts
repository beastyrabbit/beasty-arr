import { describe, expect, it } from "vitest";
import { hasGermanAudio } from "./domain.js";

describe("hasGermanAudio", () => {
  it("recognizes the canonical language id even when the name is absent", () => {
    expect(hasGermanAudio([{ id: 4 }])).toBe(true);
  });

  it("recognizes German and Deutsch labels", () => {
    expect(hasGermanAudio([{ name: "German" }])).toBe(true);
    expect(hasGermanAudio(["Deutsch"])).toBe(true);
  });

  it("does not classify explicit English metadata as German", () => {
    expect(hasGermanAudio([{ id: 1, name: "English" }])).toBe(false);
  });
});
