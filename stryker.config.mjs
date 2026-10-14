// @ts-check
// Mutation testing. Scope a run to some files with STRYKER_MUTATE="glob,glob" (e.g. one package).
const DEFAULT_MUTATE = [
    "packages/*/src/**/*.{ts,mjs}",
    "!packages/testing/**",
    "!packages/{zenmoney,zerro}/src/index.*",
];

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
    packageManager: "npm",
    testRunner: "vitest",
    vitest: {
        configFile: "vitest.config.ts",
    },
    coverageAnalysis: "perTest",
    concurrency: "50%",
    incremental: true,
    incrementalFile: "reports/stryker-incremental.json",
    reporters: ["html", "json", "clear-text", "progress"],
    htmlReporter: {
        fileName: "reports/mutation/mutation.html",
    },
    jsonReporter: {
        fileName: "reports/mutation/mutation.json",
    },
    // No break threshold here: Stryker+vitest reports phantom survivors, the gate is scripts/verify-mutants.mjs.
    thresholds: {
        high: 100,
        low: 100,
        break: null,
    },
    ignorePatterns: ["reports", "coverage", ".stryker-tmp", ".git"],
    mutate: process.env.STRYKER_MUTATE ? process.env.STRYKER_MUTATE.split(",") : DEFAULT_MUTATE,
};
