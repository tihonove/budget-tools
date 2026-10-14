import { afterEach, describe, expect, onTestFinished, test } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fakeApi, fixture, memoryMirror, type FakeApi } from "@tihonove/testing";
import {
    createHttpServer,
    errorResult,
    httpConfig,
    jsonResult,
    makeSession,
    Sessions,
    tokenFromHeaders,
    tokenHash,
    toolCall,
    type Session,
} from "@tihonove/mcp-kit";
import { makeRemote, ZmError } from "@tihonove/zenmoney";

let api: FakeApi | undefined;
afterEach(async () => {
    await api?.close();
    api = undefined;
});

async function apiWith(responses: object[] = []) {
    api = await fakeApi(responses);
    return api;
}

const users = () => ({ user: fixture("account.json").user });
const errorOf = async (r: Response) =>
    ((await r.json()) as { error: { message: string } }).error.message;

describe("makeSession", () => {
    test("syncs before the first call and again only when the mirror is older than maxAge", async () => {
        const fake = await apiWith();
        let clock = 1000;
        const ctx = { con: memoryMirror(), remote: makeRemote({ api: fake.url, token: "t" }) };
        const session = makeSession(ctx, { maxAgeMs: 100, now: () => clock });

        expect(await session.run((c) => c === ctx)).toBe(true);
        expect(fake.requests.length).toBe(1);
        clock += 100;
        await session.run(() => 1);
        expect(fake.requests.length).toBe(1);
        clock += 1;
        await session.run(() => 1);
        expect(fake.requests.length).toBe(2);
    });

    test("calls run one at a time, in order; a failed call does not block the next", async () => {
        const fake = await apiWith();
        const session = makeSession({
            con: memoryMirror(),
            remote: makeRemote({ api: fake.url, token: "t" }),
        });
        const log: string[] = [];
        const slow = session.run(async () => {
            await new Promise((r) => setTimeout(r, 20));
            log.push("slow");
        });
        const failing = session.run(() => {
            log.push("failing");
            throw new Error("boom");
        });
        const fast = session.run(() => log.push("fast"));
        await slow;
        await expect(failing).rejects.toThrow("boom");
        await fast;
        expect(log).toEqual(["slow", "failing", "fast"]);
    });

    test("defaults: 60 s and the real clock", async () => {
        const fake = await apiWith();
        const session = makeSession({
            con: memoryMirror(),
            remote: makeRemote({ api: fake.url, token: "t" }),
        });
        await session.run(() => 1);
        await session.run(() => 1);
        expect(fake.requests.length).toBe(1);
    });
});

describe("tokens", () => {
    test("tokenHash is sha256 hex", () => {
        expect(tokenHash("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    });

    test("tokenFromHeaders: Bearer (any case) first, then X-ZenMoney-Token", () => {
        expect(tokenFromHeaders({ authorization: "Bearer abc" })).toBe("abc");
        expect(tokenFromHeaders({ authorization: "bearer   abc  " })).toBe("abc");
        expect(tokenFromHeaders({ authorization: "Bearer abc", "x-zenmoney-token": "x" })).toBe(
            "abc",
        );
        expect(tokenFromHeaders({ "x-zenmoney-token": " xyz " })).toBe("xyz");
        expect(tokenFromHeaders({ authorization: "Basic abc", "x-zenmoney-token": "x" })).toBe("x");
        expect(tokenFromHeaders({ authorization: "Bearer a b" })).toBeNull();
        expect(tokenFromHeaders({ authorization: "xBearer abc" })).toBeNull();
        expect(tokenFromHeaders({ "x-zenmoney-token": "  " })).toBeNull();
        expect(tokenFromHeaders({ "x-zenmoney-token": ["a", "b"] as never })).toBeNull();
        expect(tokenFromHeaders({})).toBeNull();
    });
});

describe("Sessions", () => {
    const dir = () => path.join(mkdtempSync(path.join(tmpdir(), "mcp-kit-")), "nested", "data");

    test("checks a new token, keeps one mirror per token hash, trusts it for tokenTtlMs", async () => {
        const fake = await apiWith([users(), users()]);
        let clock = 0;
        const dataDir = dir();
        const sessions = new Sessions({ dataDir, api: fake.url, tokenTtlMs: 50, now: () => clock });
        expect(existsSync(dataDir)).toBe(true);

        const first = await sessions.forToken("tok");
        expect(first).not.toBeNull();
        expect(fake.requests[0]!.auth).toBe("Bearer tok");
        expect(existsSync(path.join(dataDir, `${tokenHash("tok")}.db`))).toBe(true);

        clock = 50;
        expect(await sessions.forToken("tok")).toBe(first);
        expect(fake.requests.length).toBe(1);

        clock = 51;
        expect(await sessions.forToken("tok")).toBe(first);
        expect(fake.requests.length).toBe(2);
    });

    test("a rejected token gets no session; a revoked one loses its session and cached mirror", async () => {
        const fake = await apiWith([users(), {}, users()]);
        let clock = 0;
        const dataDir = dir();
        const file = path.join(dataDir, `${tokenHash("tok")}.db`);
        const sessions = new Sessions({ dataDir, api: fake.url, tokenTtlMs: 10, now: () => clock });

        const first = await sessions.forToken("tok");
        expect(first).not.toBeNull();
        expect(existsSync(file)).toBe(true);

        clock = 11;
        expect(await sessions.forToken("tok")).toBeNull();
        expect(existsSync(file)).toBe(false);

        clock = 12;
        const again = await sessions.forToken("tok");
        expect(again).not.toBe(first);
        expect(existsSync(file)).toBe(true);
        expect(fake.requests.length).toBe(3);

        fake.status = 401;
        expect(await sessions.forToken("never-seen")).toBeNull();
    });

    test("defaults: 10 minutes, the real clock", async () => {
        const fake = await apiWith([users()]);
        const sessions = new Sessions({ dataDir: dir(), api: fake.url });
        await sessions.forToken("tok");
        await sessions.forToken("tok");
        expect(fake.requests.length).toBe(1);
    });
});

describe("tool results", () => {
    test("jsonResult and errorResult", () => {
        expect(jsonResult({ a: 1 })).toEqual({
            content: [{ type: "text", text: '{\n  "a": 1\n}' }],
        });
        expect(errorResult("nope")).toEqual({
            isError: true,
            content: [{ type: "text", text: "nope" }],
        });
    });

    test("toolCall: value → JSON, user-facing errors → error result, others propagate", async () => {
        expect(await toolCall(async () => [1])).toEqual(jsonResult([1]));
        expect(
            await toolCall(() => {
                throw new ZmError("not found");
            }),
        ).toEqual(errorResult("not found"));
        await expect(
            toolCall(() => {
                throw new Error("bug");
            }),
        ).rejects.toThrow("bug");
        await expect(
            toolCall(() => {
                throw "text";
            }),
        ).rejects.toBe("text");
    });
});

describe("http", () => {
    function echoServer(session: Session) {
        const server = new McpServer({ name: "echo", version: "1" });
        server.registerTool("whoami", { description: "user id" }, () =>
            toolCall(() =>
                session.run(
                    ({ con }) =>
                        (con.prepare("SELECT count(*) n FROM tag").get() as { n: number }).n,
                ),
            ),
        );
        return server;
    }

    async function start(sessions: Pick<Sessions, "forToken">, endpoint?: string) {
        const server = createHttpServer({
            createServer: echoServer,
            sessions,
            ...(endpoint && { path: endpoint }),
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
        onTestFinished(() => new Promise<void>((r) => server.close(() => r())));
        return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    const noSessions = { forToken: async () => null };

    test("healthz, unknown paths, wrong methods", async () => {
        const base = await start(noSessions);
        const health = await fetch(`${base}/healthz`);
        expect([health.status, health.headers.get("content-type"), await health.text()]).toEqual([
            200,
            "text/plain",
            "ok",
        ]);

        const missing = await fetch(`${base}/other`, { method: "POST" });
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({
            jsonrpc: "2.0",
            error: { code: -32001, message: "not found" },
            id: null,
        });

        const get = await fetch(`${base}/mcp`);
        expect([get.status, get.headers.get("allow"), get.headers.get("content-type")]).toEqual([
            405,
            "POST",
            "application/json",
        ]);
        expect(await errorOf(get)).toBe("method not allowed");
    });

    test("401 without a token or with a rejected one", async () => {
        const base = await start(noSessions);
        const none = await fetch(`${base}/mcp`, { method: "POST" });
        expect([none.status, none.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
        expect(await errorOf(none)).toBe(
            "ZenMoney token required: Authorization: Bearer <token> or X-ZenMoney-Token",
        );
        const bad = await fetch(`${base}/mcp`, {
            method: "POST",
            headers: { Authorization: "Bearer x" },
        });
        expect([bad.status, bad.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
        expect(await errorOf(bad)).toBe("ZenMoney rejected the token");
    });

    test("an SDK client talks to the user's session over Streamable HTTP", async () => {
        const fake = await apiWith([fixture("account.json")]);
        const ctx = {
            con: memoryMirror({ tag: [] }),
            remote: makeRemote({ api: fake.url, token: "t" }),
        };
        const tokens: string[] = [];
        const base = await start(
            {
                forToken: async (token) => {
                    tokens.push(token);
                    return makeSession(ctx);
                },
            },
            "/custom",
        );
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/custom`), {
            requestInit: { headers: { "X-ZenMoney-Token": "secret" } },
        });
        const client = new Client({ name: "t", version: "1" });
        await client.connect(transport);
        onTestFinished(() => client.close());

        expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["whoami"]);
        const result = await client.callTool({ name: "whoami", arguments: {} });
        expect(result.content).toEqual([{ type: "text", text: "4" }]);
        expect(new Set(tokens)).toEqual(new Set(["secret"]));
    });
});

test("http: plain JSON answers (no SSE); the per-request server is closed after the response", async () => {
    const fake = await apiWith();
    const session = makeSession({
        con: memoryMirror(),
        remote: makeRemote({ api: fake.url, token: "t" }),
    });
    const servers: McpServer[] = [];
    const http = createHttpServer({
        createServer: () => {
            const server = new McpServer({ name: "s", version: "1" });
            servers.push(server);
            return server;
        },
        sessions: { forToken: async () => session },
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    onTestFinished(() => new Promise<void>((r) => http.close(() => r())));

    const response = await fetch(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, {
        method: "POST",
        headers: {
            Authorization: "Bearer t",
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "c", version: "1" },
            },
        }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(
        ((await response.json()) as { result: { serverInfo: unknown } }).result.serverInfo,
    ).toEqual({
        name: "s",
        version: "1",
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(servers.length).toBe(1);
    expect(servers[0]!.isConnected()).toBe(false);
});

test("httpConfig: defaults and environment", () => {
    expect(httpConfig({})).toEqual({
        port: 8080,
        host: "0.0.0.0",
        dataDir: path.resolve("data"),
        api: "https://api.zenmoney.ru",
    });
    expect(httpConfig({ PORT: "9", HOST: "h", DATA_DIR: "/d", ZENMONEY_API: "http://a" })).toEqual({
        port: 9,
        host: "h",
        dataDir: "/d",
        api: "http://a",
    });
    expect(httpConfig().port).toBe(Number(process.env.PORT || 8080));
});
