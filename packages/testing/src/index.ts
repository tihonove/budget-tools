// Test harness: a fake ZenMoney /v8/diff/ endpoint, sandboxes that run the CLIs in-process,
// an in-memory mirror, and the guard for live tests. Each sandbox has its own temp dir and db.
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { captureIo, type Io } from "@tihonove/cli-kit";
import { checkToken, db, makeRemote, q, type Diff, type Remote } from "@tihonove/zenmoney";

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.resolve(here, "../..");
const FIXTURES = path.resolve(here, "../fixtures");

export function fixture<T = Diff>(name: string): T {
    return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

type Main = (argv: string[], io: Io) => Promise<number>;

/** In-process entry points, loaded lazily so a package's tests don't load the other CLIs. */
const CLIS: Record<string, () => Promise<Main>> = {
    zm: async () => (await import("@tihonove/zenmoney/cli")).main,
    zerro: async () => (await import("@tihonove/zerro/cli")).main,
};

/** bin/ scripts for subprocess smoke tests. */
export const BINS = {
    zm: path.join(PACKAGES, "zenmoney/bin/zm.ts"),
    zerro: path.join(PACKAGES, "zerro/bin/zerro.ts"),
};

export interface Recorded {
    url: string;
    auth: string | undefined;
    contentType: string | undefined;
    body: Record<string, unknown>;
}

export interface FakeApi {
    url: string;
    requests: Recorded[];
    /** Answer status; set to e.g. 401 to make the next requests fail. */
    status: number;
    /** Body of failed answers. */
    errorBody: string;
    close(): Promise<void>;
}

/**
 * Fake API. `responses` is a queue of diff responses; when it is empty the server answers
 * with an empty diff. Every request body is recorded in `requests`.
 */
/** A queued answer: a diff, or a function of the request body and all requests so far. */
export type Response = Diff | ((body: Record<string, unknown>, requests: Recorded[]) => Diff);

/** An answer that echoes the accounts and reminders sent by the previous request (a push). */
export const echoPushed =
    (extra: Diff = {}): Response =>
    (_, requests) => {
        const pushed = requests.at(-2)!.body as Diff;
        return {
            account: [...(extra.account ?? []), ...(pushed.account ?? [])],
            reminder: [...(extra.reminder ?? []), ...(pushed.reminder ?? [])],
        };
    };

export async function fakeApi(responses: Response[] = []): Promise<FakeApi> {
    let ts = 1_800_000_000;
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            api.requests.push({
                url: req.url ?? "",
                auth: req.headers.authorization,
                contentType: req.headers["content-type"],
                body: JSON.parse(body || "{}"),
            });
            if (api.status !== 200) {
                res.writeHead(api.status);
                res.end(api.errorBody);
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            const next = responses.shift() ?? {};
            const answer =
                typeof next === "function" ? next(api.requests.at(-1)!.body, api.requests) : next;
            res.end(JSON.stringify({ serverTimestamp: ++ts, ...answer }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    const api: FakeApi = {
        url: `http://127.0.0.1:${port}`,
        requests: [],
        status: 200,
        errorBody: "nope",
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
    return api;
}

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface Sandbox {
    dir: string;
    api: FakeApi;
    env: Record<string, string>;
    remote: Remote;
    zm(...args: string[]): Promise<RunResult>;
    zmIn(stdin: string, ...args: string[]): Promise<RunResult>;
    zerro(...args: string[]): Promise<RunResult>;
    /** Run a bin/ script in a real subprocess. */
    spawn(bin: keyof typeof BINS, args: string[], stdin?: string): Promise<RunResult>;
    /** Open the sandbox mirror directly. */
    db(): DatabaseSync;
    close(): Promise<void>;
}

export async function sandbox(
    responses: Response[] = [],
    options: { env?: Record<string, string> } = {},
): Promise<Sandbox> {
    const dir = mkdtempSync(path.join(tmpdir(), "zm-test-"));
    const api = await fakeApi(responses);
    const env = {
        ZENMONEY_DB: path.join(dir, "zenmoney.db"),
        ZENMONEY_API: api.url,
        ZENMONEY_TOKEN: "test-token",
        ...options.env,
    };

    const call = async (cli: string, args: string[], stdin = ""): Promise<RunResult> => {
        const io = captureIo({ env, cwd: dir, stdin });
        const code = await (await CLIS[cli]!())(args, io);
        return { code, stdout: io.out(), stderr: io.err() };
    };

    const spawn = (bin: keyof typeof BINS, args: string[], stdin = ""): Promise<RunResult> =>
        new Promise((resolve) => {
            const child = execFile(
                process.execPath,
                [BINS[bin], ...args],
                { env: { ...process.env, ...env }, cwd: dir },
                (err, stdout, stderr) =>
                    resolve({ code: err ? Number(err.code ?? 1) : 0, stdout, stderr }),
            );
            child.stdin!.end(stdin);
        });

    return {
        dir,
        api,
        env,
        remote: makeRemote({ api: api.url, token: "test-token" }),
        zm: (...args) => call("zm", args),
        zmIn: (stdin, ...args) => call("zm", args, stdin),
        zerro: (...args) => call("zerro", args),
        spawn,
        db: () => db(env.ZENMONEY_DB),
        async close() {
            await api.close();
            rmSync(dir, { recursive: true, force: true });
        },
    };
}

/** Sandbox already synced with fixtures/account.json (+ more queued responses). */
export async function syncedSandbox(
    more: Response[] = [],
    options?: { env?: Record<string, string> },
): Promise<Sandbox> {
    const sb = await sandbox([fixture("account.json"), ...more], options);
    const r = await sb.zm("sync");
    if (r.code) throw new Error("sync failed: " + r.stderr);
    sb.api.requests.length = 0;
    return sb;
}

/** In-memory mirror filled with fixtures/account.json; `extra` replaces whole entity arrays. */
export function memoryMirror(extra: Diff = {}): DatabaseSync {
    const con = db(":memory:");
    const data = { ...fixture("account.json"), ...extra } as Record<
        string,
        Record<string, unknown>[]
    >;
    for (const [entity, items] of Object.entries(data)) {
        if (!Array.isArray(items)) continue;
        const insert = con.prepare(`INSERT INTO ${q(entity)} VALUES (?,?,?)`);
        for (const o of items) {
            const id = entity === "budget" ? `${o.tag}:${o.date}` : String(o.id);
            insert.run(id, o.changed as number, JSON.stringify(o));
        }
    }
    return con;
}

// ----------------------------------------------------------------------------- live tests

export interface LiveConfig {
    token: string;
    userId: number;
    api: string;
}

/**
 * Live test config from the environment, or null when not configured:
 *   ZENMONEY_TEST_TOKEN (or ZENMONEY_TEST_TOKEN_FILE), ZENMONEY_TEST_USER_ID, ZENMONEY_API (optional).
 */
export function liveConfig(
    env: Record<string, string | undefined> = process.env,
): LiveConfig | null {
    const file = env.ZENMONEY_TEST_TOKEN_FILE;
    const token =
        env.ZENMONEY_TEST_TOKEN?.trim() || (file ? readFileSync(file, "utf8").trim() : "");
    const userId = Number(env.ZENMONEY_TEST_USER_ID);
    if (!token || !userId) return null;
    return { token, userId, api: env.ZENMONEY_API || "https://api.zenmoney.ru" };
}

/**
 * The guard: resolves the token's user and refuses to go on unless it is the configured
 * test user. Every live test gets its remote through this function.
 */
export async function liveRemote(config: LiveConfig): Promise<Remote> {
    const remote = makeRemote({ api: config.api, token: config.token });
    const owner = await checkToken(remote);
    if (!owner) throw new Error(`live: token rejected by ${config.api}`);
    if (owner.id !== config.userId) {
        throw new Error(
            `live: token belongs to user ${owner.id}, expected test user ${config.userId} — refusing to run`,
        );
    }
    return remote;
}
export * from "./mcp.ts";
export * from "./bins.ts";
