import { defineConfig } from "vitest/config";
import { alias } from "./vitest.config.ts";

// Live tests against a real ZenMoney test account (never a personal one):
//   ZENMONEY_TEST_TOKEN or ZENMONEY_TEST_TOKEN_FILE, ZENMONEY_TEST_USER_ID.
// Every test gets its remote through liveRemote(), which refuses any other user.
// Without the variables the tests are skipped. No coverage, no mutation: the network is not deterministic.
export default defineConfig({
    resolve: { alias },
    test: {
        include: ["packages/*/test-live/**/*.live.test.ts"],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        fileParallelism: false,
    },
});
