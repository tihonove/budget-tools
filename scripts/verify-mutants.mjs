#!/usr/bin/env node
// Mutation gate: re-checks every mutant Stryker did not kill, by injecting it for real.
//
// Stryker + vitest is flaky here: the same commit gives different "survivors" from run to run,
// including mutants that obviously break tests (an emptied function body). So the score from
// reports/mutation/mutation.json is not trusted as is. For each Survived / NoCoverage mutant this
// script copies the repo to a temp dir, applies the mutant's replacement to the source, and runs the
// test files that cover it (all tests for NoCoverage). Tests fail or hang → the mutant is killed
// (a phantom). Tests pass → a real survivor, and the gate fails.
//
// Usage: node scripts/verify-mutants.mjs [--report reports/mutation/mutation.json] [--timeout 60]
// Writes reports/mutation/verdict.json; exit code 1 if any real survivor remains.
import { spawnSync } from "node:child_process";
import {
    cpSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
    mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const arg = (name, def) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : def;
};
const reportFile = path.resolve(root, arg("report", "reports/mutation/mutation.json"));
const timeoutSec = Number(arg("timeout", "60"));

const report = JSON.parse(readFileSync(reportFile, "utf8"));
const testFileOf = new Map(); // test id → test file
for (const [file, tf] of Object.entries(report.testFiles ?? {}))
    for (const t of tf.tests ?? []) testFileOf.set(t.id, file);

const candidates = [];
for (const [file, data] of Object.entries(report.files)) {
    for (const m of data.mutants)
        if (m.status === "Survived" || m.status === "NoCoverage")
            candidates.push({ file, source: data.source, m });
}

const offset = (src, { line, column }) => {
    let pos = 0;
    for (let l = 1; l < line; l++) pos = src.indexOf("\n", pos) + 1;
    return pos + column - 1;
};

function sandbox() {
    const dir = mkdtempSync(path.join(tmpdir(), "verify-mutants-"));
    cpSync(root, dir, {
        recursive: true,
        filter: (s) => !/[/\\](node_modules|reports|coverage|\.stryker-tmp|\.git)$/.test(s),
    });
    symlinkSync(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
    return dir;
}

const verdicts = [];
if (candidates.length) {
    const dir = sandbox();
    try {
        for (const { file, source, m } of candidates) {
            const target = path.join(dir, file);
            const mutated =
                source.slice(0, offset(source, m.location.start)) +
                m.replacement +
                source.slice(offset(source, m.location.end));
            writeFileSync(target, mutated);
            const files = [
                ...new Set((m.coveredBy ?? []).map((id) => testFileOf.get(id)).filter(Boolean)),
            ];
            const r = spawnSync(
                process.execPath,
                [path.join(root, "node_modules/vitest/vitest.mjs"), "run", ...files],
                { cwd: dir, encoding: "utf8", timeout: timeoutSec * 1000, killSignal: "SIGKILL" },
            );
            writeFileSync(target, source);
            const klass =
                r.error?.code === "ETIMEDOUT" || r.signal
                    ? "timeout"
                    : r.status === 0
                      ? "real"
                      : "phantom";
            verdicts.push({
                id: m.id,
                file,
                line: m.location.start.line,
                mutator: m.mutatorName,
                replacement: m.replacement,
                stryker: m.status,
                verdict: klass,
            });
            process.stdout.write(
                `${klass.padEnd(8)} ${file}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName} → ${JSON.stringify(m.replacement).slice(0, 60)}\n`,
            );
        }
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const real = verdicts.filter((v) => v.verdict === "real");
let total = 0,
    killed = 0;
for (const data of Object.values(report.files))
    for (const m of data.mutants) {
        if (m.status === "Ignored" || m.status === "CompileError") continue;
        total++;
        if (m.status === "Killed" || m.status === "Timeout") killed++;
    }
const score = total ? (100 * (total - real.length)) / total : 100;
mkdirSync(path.dirname(reportFile), { recursive: true });
writeFileSync(
    path.join(path.dirname(reportFile), "verdict.json"),
    JSON.stringify(
        {
            score,
            total,
            strykerKilled: killed,
            rechecked: verdicts.length,
            real: real.length,
            verdicts,
        },
        null,
        2,
    ),
);
console.log(
    `\nmutants: ${total}, Stryker killed ${killed}, re-checked ${verdicts.length}: ${verdicts.length - real.length} phantom/timeout, ${real.length} real survivor(s)`,
);
console.log(`verified mutation score: ${score.toFixed(2)}%`);
process.exitCode = real.length ? 1 : 0;
