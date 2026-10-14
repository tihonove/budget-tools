// Smoke test of the real bin/zerro.ts in a subprocess.
import { expect, onTestFinished, test } from "vitest";
import { sandbox, syncedSandbox } from "@tihonove/testing";

test("zerro bin prints and exits with the command's code", async () => {
    const sb = await syncedSandbox([], { env: { ZERRO_TODAY: "2026-10-13" } });
    onTestFinished(() => sb.close());
    const ok = await sb.spawn("zerro", ["show"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/^2026-10, EUR\. Income 1 000,00/);
    expect(ok.stderr).toBe("");
});

test("zerro bin: errors exit 1 with a one-line message", async () => {
    const sb = await sandbox();
    onTestFinished(() => sb.close());
    expect(await sb.spawn("zerro", ["show"])).toEqual({
        code: 1,
        stdout: "",
        stderr: "zerro: cache empty: run `zm sync` first\n",
    });
});
