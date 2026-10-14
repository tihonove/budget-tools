import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to source files next to this config, not through node_modules symlinks:
// Stryker copies the repo into a sandbox and mutates the copies, while node_modules/@tihonove/* would
// still point at the originals — tests would import unmutated code and every mutant would look uncovered.
export const alias = [
    { find: /^@tihonove\/([^/]+)\/cli$/, replacement: here("./packages/$1/src/cli") },
    { find: /^@tihonove\/([^/]+)$/, replacement: here("./packages/$1/src/index") },
];

// Unit tests: fake API, temp dirs, no network. Live tests (test-live/) have their own config.
export default defineConfig({
    resolve: { alias },
    test: {
        include: ["packages/*/test/**/*.test.{ts,mjs}"],
        coverage: {
            provider: "v8",
            reportOnFailure: true,
            include: ["packages/*/src/**/*.{ts,mjs}"],
            // testing/ is the harness itself; zenmoney/zerro index files are barrels (re-exports only).
            exclude: ["packages/testing/**", "packages/{zenmoney,zerro}/src/index.*"],
            reporter: ["text", "lcov", "json", "json-summary", "text-summary"],
            // Ratchet (as in diode): CI fails when coverage drops; numbers move up by themselves.
            thresholds: {
                autoUpdate: true,
                statements: 100,
                branches: 100,
                functions: 100,
                lines: 100,
            },
        },
    },
});
