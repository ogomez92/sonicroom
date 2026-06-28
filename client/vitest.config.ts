import { defineConfig } from "vitest/config";

// Standalone test config (kept separate from vite.config.ts so the paraglide /
// tailwind build plugins don't run under the test runner — the generated
// paraglide messages are read from disk as plain files). jsdom gives us a DOM;
// setup.ts installs the Web Audio / WebRTC / getUserMedia fakes jsdom lacks.
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts"],
    restoreMocks: true,
  },
});
