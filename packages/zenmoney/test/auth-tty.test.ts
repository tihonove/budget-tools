// `zm auth` in a terminal: the token is asked interactively (readline is faked here).
import { expect, onTestFinished, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { captureIo } from "@tihonove/cli-kit";
import { sandbox } from "@tihonove/testing";

vi.mock("node:readline", () => ({
    default: {
        createInterface: () => ({
            question: (_: string, answer: (s: string) => void) => answer("  tty-token  "),
            close: () => {},
        }),
    },
}));

test("auth in a terminal asks for the token instead of reading stdin", async () => {
    const sb = await sandbox();
    onTestFinished(() => sb.close());
    const { main } = await import("@tihonove/zenmoney/cli");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    onTestFinished(() => write.mockRestore());

    const io = captureIo({
        env: { ...sb.env, ZENMONEY_TOKEN_FILE: "t" },
        cwd: sb.dir,
        stdin: "ignored",
        isTTY: true,
    });
    expect(await main(["auth", "--no-browser", "--no-check"], io)).toBe(0);
    expect(io.out()).toBe(
        `Get the token at https://zerro.app/token\nsaved to ${path.join(sb.dir, "t")}\n`,
    );
    expect(readFileSync(path.join(sb.dir, "t"), "utf8")).toBe("tty-token\n");
});
