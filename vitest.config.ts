import { defineConfig } from "vitest/config";

// No network in any test: every client the code takes is handed in, and the
// tests hand in fakes. `test/parity.test.ts` also reads the Feast app's own
// source when this folder sits inside that repository, and skips itself when
// it does not. From the repository root: `npx vitest run --root tools/bot-starter`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
