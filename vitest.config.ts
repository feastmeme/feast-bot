import { defineConfig } from "vitest/config";

// No network in any test: every client the code takes is handed in, and the
// tests hand in fakes. `test/parity.test.ts` also reads the Feast app's own
// source when this folder sits inside that repository, and skips itself when
// it does not. From the repository root: `npx vitest run --root tools/bot-starter`.
// The model is a fake too; `test/anthropic.test.ts` runs Anthropic's own
// library against a stand-in server on 127.0.0.1, never Anthropic's API.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
