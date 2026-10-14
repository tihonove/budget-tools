// Smoke tests of the real bin/ scripts in a subprocess: the runMain glue, exit codes, stdin, closed pipes.
import { expect, onTestFinished, test } from "vitest";
import { sandbox, syncedSandbox } from "@tihonove/testing";

test("zm bin prints, reads stdin and exits with the command's code", async () => {
    const sb = await syncedSandbox();
    onTestFinished(() => sb.close());

    const ok = await sb.spawn("zm", ["status"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^user 1 \(test\), main currency EUR\n/);

    const piped = await sb.spawn("zm", ["push", "-", "--dry-run"], '{"tag":[]}');
    expect(piped.stdout).toBe('{\n  "tag": []\n}\n');
});

test("zm bin: errors exit 1 with a one-line message, no stack", async () => {
    const sb = await sandbox();
    onTestFinished(() => sb.close());
    expect(await sb.spawn("zm", ["frobnicate"])).toEqual({
        code: 1,
        stdout: "",
        stderr: "error: unknown command 'frobnicate'\n",
    });
    expect(await sb.spawn("zm", ["status"])).toEqual({
        code: 1,
        stdout: "",
        stderr: "zm: cache empty: run `zm sync` first\n",
    });
});
