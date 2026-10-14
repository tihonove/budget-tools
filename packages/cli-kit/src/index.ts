// Shared CLI plumbing for zm and zerro, on top of commander.
//
// Everything goes through an `io` object, so a CLI runs in-process (tests, other front-ends)
// exactly as from a shell. runProgram() never exits the process — it returns the exit code.
import { readFileSync } from "node:fs";
import { format } from "node:util";
import { Command, CommanderError, InvalidArgumentError } from "commander";

export { Command } from "commander";

// ------------------------------------------------------------------------------------- io

export interface Writable {
    write(s: string): unknown;
}

export interface IoOptions {
    stdout?: Writable;
    stderr?: Writable;
    /** stdin contents, or a function reading them on demand */
    stdin?: string | (() => string);
    env?: Record<string, string | undefined>;
    cwd?: string;
    isTTY?: boolean;
}

export interface Io {
    stdout: Writable;
    stderr: Writable;
    env: Record<string, string | undefined>;
    cwd: string;
    isTTY: boolean;
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
    /** Read a file, or stdin for "-". */
    readInput(file: string): string;
}

// The real stdin is only read in a subprocess (bin smoke tests): in-process it would block the runner.
/* v8 ignore start */
// Stryker disable next-line all
const readRealStdin = (): string => readFileSync(0, "utf8");
/* v8 ignore stop */

/** Missing fields default to the real process. */
export function makeIo(options: IoOptions = {}): Io {
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    const stdin = options.stdin ?? readRealStdin;

    return {
        stdout,
        stderr,
        env: options.env ?? process.env,
        cwd: options.cwd ?? process.cwd(),
        isTTY: options.isTTY ?? !!process.stdin.isTTY,
        log: (...args) => stdout.write(format(...args) + "\n"),
        error: (...args) => stderr.write(format(...args) + "\n"),
        readInput: (file) => {
            if (file !== "-") return readFileSync(file, "utf8");
            return typeof stdin === "function" ? stdin() : stdin;
        },
    };
}

export interface CapturedIo extends Io {
    out(): string;
    err(): string;
}

/** In-memory io for tests: makeIo() plus .out() / .err() accessors. */
export function captureIo(options: Omit<IoOptions, "stdout" | "stderr"> = {}): CapturedIo {
    let out = "";
    let err = "";
    const io = makeIo({
        stdin: "",
        env: {},
        isTTY: false,
        ...options,
        stdout: { write: (s) => (out += s) },
        stderr: { write: (s) => (err += s) },
    });
    return Object.assign(io, { out: () => out, err: () => err });
}

// --------------------------------------------------------------------------------- tables

export type Row = Record<string, unknown>;

/** Plain aligned table; null/undefined cells are empty. */
export function printTable(io: Io, rows: Row[], columns?: string[]): void {
    if (rows.length === 0) {
        io.log("(empty)");
        return;
    }
    const cols = columns ?? Object.keys(rows[0]!);
    const cells = rows.map((row) => cols.map((c) => (row[c] == null ? "" : String(row[c]))));
    const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((line) => line[i]!.length)));
    const render = (line: string[]) => line.map((v, i) => v.padEnd(widths[i]!)).join("  ");

    io.log(render(cols));
    for (const line of cells) io.log(render(line));
}

/** Rows as a table, or as pretty JSON with --json. */
export function printRows(io: Io, rows: Row[], asJson = false, columns?: string[]): void {
    if (asJson) io.log(JSON.stringify(rows, null, 2));
    else printTable(io, rows, columns);
}

// ------------------------------------------------------------------------- option parsers

/** commander option parser for numbers. */
export function parseNumber(value: string): number {
    const n = Number(value);
    if (value.trim() === "" || Number.isNaN(n)) throw new InvalidArgumentError("Not a number.");
    return n;
}

/** commander option parser for "true/false/yes/no/1/0". */
export function parseBool(value: string): boolean {
    const v = value.toLowerCase();
    if (["1", "true", "yes", "y"].includes(v)) return true;
    if (["0", "false", "no", "n"].includes(v)) return false;
    throw new InvalidArgumentError("Expected true or false.");
}

/** commander option parser for repeatable options: --tag a --tag b → ["a", "b"]. */
export function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

// ------------------------------------------------------------------------------- programs

/** Expected errors (bad input, not found) carry `userFacing: true`: message only, no stack. */
export function isUserFacing(e: unknown): e is Error {
    return e instanceof Error && (e as { userFacing?: unknown }).userFacing === true;
}

/** A user-facing error: printed as "prog: message", exit code 1. */
export class UserError extends Error {
    readonly userFacing = true;
}

/** A root command whose output goes to `io` and whose errors become exit codes (see runProgram). */
export function createProgram(name: string, io: Io): Command {
    return new Command(name).exitOverride().configureOutput({
        writeOut: (s) => io.stdout.write(s),
        writeErr: (s) => io.stderr.write(s),
    });
}

/** Parse argv (user arguments, without node and script) and run the matching action; returns the exit code. */
export async function runProgram(program: Command, argv: string[], io: Io): Promise<number> {
    try {
        await program.parseAsync(argv, { from: "user" });
        return 0;
    } catch (e) {
        if (e instanceof CommanderError) return e.exitCode;
        if (isUserFacing(e)) {
            io.error(`${program.name()}: ${e.message}`);
            return 1;
        }
        throw e;
    }
}

// Process glue for bin/ scripts. It only runs in a real process, which the bin smoke tests start;
// neither v8 coverage nor Stryker see into that subprocess.
/* v8 ignore start */
// Stryker disable all
/** Entry point for bin/ scripts: run main() against the real process; a closed pipe (`| head`) is not an error. */
export async function runMain(main: (argv: string[], io: Io) => Promise<number>): Promise<void> {
    for (const stream of [process.stdout, process.stderr]) {
        stream.on("error", (e: NodeJS.ErrnoException) => {
            if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
            throw e;
        });
    }
    process.exitCode = await main(process.argv.slice(2), makeIo());
}
// Stryker restore all
/* v8 ignore stop */
