import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawn } from "node:child_process";
import { getPriority } from "node:os";
import { lowerPriority } from "./audio-sources.js";

describe("lowerPriority", () => {
  it("raises a child's niceness so batch ffmpeg can't outrank live media", () => {
    const child = spawn("sleep", ["5"]);
    try {
      lowerPriority(child);
      assert.ok(getPriority(child.pid!) >= 10);
    } finally {
      child.kill();
    }
  });

  it("ignores a fake process with no pid", () => {
    const fake = {};
    assert.equal(lowerPriority(fake), fake);
  });
});
