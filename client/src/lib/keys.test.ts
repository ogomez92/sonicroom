import { describe, expect, it } from "vitest";
import { altKeyLabel, isMacPlatform } from "./keys";

describe("isMacPlatform", () => {
  it("recognises macOS and iPadOS, not Windows/Linux", () => {
    expect(isMacPlatform({ platform: "MacIntel", userAgent: "" })).toBe(true);
    expect(
      isMacPlatform({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)" }),
    ).toBe(true);
    expect(isMacPlatform({ platform: "iPad", userAgent: "" })).toBe(true);
    expect(isMacPlatform({ platform: "Win32", userAgent: "Mozilla/5.0 (Windows NT 10.0)" })).toBe(
      false,
    );
    expect(
      isMacPlatform({ platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }),
    ).toBe(false);
    expect(isMacPlatform(undefined)).toBe(false);
  });
});

describe("altKeyLabel", () => {
  it("says Option on a Mac and Alt elsewhere", () => {
    expect(altKeyLabel(true)).toBe("Option");
    expect(altKeyLabel(false)).toBe("Alt");
  });
});
