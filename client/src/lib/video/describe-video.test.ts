import { describe, it, expect } from "vitest";
import { buildDescribePrompt, languageName } from "./describe-video";

describe("buildDescribePrompt", () => {
  it("asks for the UI language by its native name and frames the subject", () => {
    const p = buildDescribePrompt("Español", "camera");
    expect(p).toContain("Answer in Español.");
    expect(p).toContain("another participant's webcam");
    expect(p).toContain("transcribe it verbatim");
  });
  it("treats a shared screen as content to summarise + transcribe", () => {
    const p = buildDescribePrompt("English", "screen");
    expect(p).toContain("shared screen");
    expect(p).toContain("slides, code, a document");
  });
  it("names the user's own webcam for self-describe", () => {
    expect(buildDescribePrompt("Français", "self")).toContain("the user's own webcam");
  });
});

describe("languageName", () => {
  it("resolves a supported locale to its native name", () => {
    expect(languageName("es")).toBe("Español");
    expect(languageName("fr")).toBe("Français");
    expect(languageName("en")).toBe("English");
  });
});
