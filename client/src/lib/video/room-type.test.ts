import { describe, it, expect } from "vitest";
import { isVideoRoomParam, roomTypeFromParam } from "./room-type";

describe("isVideoRoomParam", () => {
  it("accepts the documented truthy spellings, case-insensitively", () => {
    for (const v of ["true", "on", "yes", "1", "enable", "enabled", "video", "TRUE", " On "]) {
      expect(isVideoRoomParam(v)).toBe(true);
    }
  });
  it("treats off/false/no, unknown values and a missing param as audio (the default)", () => {
    for (const v of ["off", "false", "no", "0", "disable", "disabled", "", "maybe", null]) {
      expect(isVideoRoomParam(v)).toBe(false);
    }
  });
  it("maps to the room type", () => {
    expect(roomTypeFromParam("on")).toBe("video");
    expect(roomTypeFromParam(null)).toBe("audio");
  });
});
