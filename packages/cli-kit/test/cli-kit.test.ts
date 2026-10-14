import { describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
    captureIo,
    collect,
    createProgram,
    isUserFacing,
    makeIo,
    parseBool,
    parseNumber,
    printRows,
    printTable,
    runProgram,
    UserError,
    type CapturedIo,
} from "@tihonove/cli-kit";

describe("io", () => {
    test("makeIo defaults to the real process", () => {
        const io = makeIo();
        expect(io.stdout).toBe(process.stdout);
        expect(io.stderr).toBe(process.stderr);
        expect(io.env).toBe(process.env);
        expect(io.cwd).toBe(process.cwd());
        expect(io.isTTY).toBe(!!process.stdin.isTTY);
    });

    test("log and error format like console and end with a newline", () => {
        const io = captureIo();
        io.log("a %s", "b", 1);
        io.error({ x: 1 });
        expect(io.out()).toBe("a b 1\n");
        expect(io.err()).toBe("{ x: 1 }\n");
    });

    test("readInput: '-' is stdin (a string or a lazy function), anything else is a file", () => {
        expect(captureIo({ stdin: "piped" }).readInput("-")).toBe("piped");
        expect(captureIo().readInput("-")).toBe("");

        let reads = 0;
        const lazy = makeIo({ stdin: () => (reads++, "lazy") });
        expect(reads).toBe(0);
        expect(lazy.readInput("-")).toBe("lazy");

        const file = path.join(mkdtempSync(path.join(tmpdir(), "cli-kit-")), "in.txt");
        writeFileSync(file, "from file");
        expect(captureIo({ stdin: "nope" }).readInput(file)).toBe("from file");
    });

    test("captureIo: empty env, not a TTY, unless given", () => {
        expect([captureIo().env, captureIo().isTTY]).toEqual([{}, false]);
        const io = captureIo({ env: { A: "1" }, cwd: "/x", isTTY: true });
        expect([io.env, io.cwd, io.isTTY]).toEqual([{ A: "1" }, "/x", true]);
    });
});

describe("tables", () => {
    test("columns are padded to the widest cell, null and undefined are empty", () => {
        const io = captureIo();
        printTable(io, [
            { id: 1, name: "long name", x: null },
            { id: 22, name: "b", x: undefined },
        ]);
        expect(io.out()).toBe("id  name       x\n" + "1   long name   \n" + "22  b           \n");
    });

    test("explicit columns pick and order fields", () => {
        const io = captureIo();
        printTable(io, [{ a: 1, b: 2 }], ["b"]);
        expect(io.out()).toBe("b\n2\n");
    });

    test("no rows", () => {
        const io = captureIo();
        printTable(io, []);
        expect(io.out()).toBe("(empty)\n");
    });

    test("printRows: a table, or pretty JSON", () => {
        const table = captureIo();
        const json = captureIo();
        printRows(table, [{ a: 1, b: 2 }], false, ["a"]);
        printRows(json, [{ a: 1 }], true);
        expect(table.out()).toBe("a\n1\n");
        expect(json.out()).toBe('[\n  {\n    "a": 1\n  }\n]\n');
    });
});

describe("option parsers", () => {
    test("parseNumber", () => {
        expect(parseNumber("12.5")).toBe(12.5);
        expect(parseNumber("-3")).toBe(-3);
        expect(() => parseNumber("abc")).toThrow("Not a number.");
        expect(() => parseNumber("  ")).toThrow("Not a number.");
    });

    test("parseBool", () => {
        for (const v of ["1", "true", "TRUE", "yes", "Y"]) expect(parseBool(v)).toBe(true);
        for (const v of ["0", "false", "No", "n"]) expect(parseBool(v)).toBe(false);
        expect(() => parseBool("maybe")).toThrow("Expected true or false.");
    });

    test("collect", () => {
        expect(collect("a")).toEqual(["a"]);
        expect(collect("b", ["a"])).toEqual(["a", "b"]);
    });
});

describe("programs", () => {
    function program(io: CapturedIo) {
        const calls: unknown[] = [];
        const p = createProgram("prog", io).description("Test program.");
        p.command("ok")
            .option("--n <n>", "a number", parseNumber)
            .action((opts) => {
                calls.push(opts);
                io.log("ran");
            });
        p.command("user").action(() => {
            throw new UserError("bad input");
        });
        p.command("crash").action(() => {
            throw new Error("bug");
        });
        return { p, calls };
    }

    async function run(argv: string[]) {
        const io = captureIo();
        const { p, calls } = program(io);
        const code = await runProgram(p, argv, io);
        return { code, out: io.out(), err: io.err(), calls };
    }

    test("runs the action and returns 0", async () => {
        expect(await run(["ok", "--n", "2"])).toEqual({
            code: 0,
            out: "ran\n",
            err: "",
            calls: [{ n: 2 }],
        });
    });

    test("help goes to io.stdout with exit code 0", async () => {
        const r = await run(["--help"]);
        expect(r.code).toBe(0);
        expect(r.out).toMatch(/^Usage: prog \[options\] \[command\]\n\nTest program\./);
        expect(r.err).toBe("");
    });

    test("commander errors go to io.stderr with commander's exit code", async () => {
        expect(await run(["nope"])).toMatchObject({
            code: 1,
            out: "",
            err: "error: unknown command 'nope'\n",
        });
        expect(await run(["ok", "--n", "x"])).toMatchObject({
            code: 1,
            err: "error: option '--n <n>' argument 'x' is invalid. Not a number.\n",
        });
    });

    test("user-facing errors print 'prog: message' and return 1", async () => {
        expect(await run(["user"])).toMatchObject({ code: 1, out: "", err: "prog: bad input\n" });
    });

    test("unexpected errors propagate", async () => {
        await expect(run(["crash"])).rejects.toThrow("bug");
    });
});

test("isUserFacing", () => {
    expect(isUserFacing(new UserError("x"))).toBe(true);
    expect(isUserFacing(Object.assign(new Error("x"), { userFacing: true }))).toBe(true);
    expect(isUserFacing(Object.assign(new Error("x"), { userFacing: "yes" }))).toBe(false);
    expect(isUserFacing(new Error("x"))).toBe(false);
    expect(isUserFacing({ userFacing: true, message: "x" })).toBe(false);
});
