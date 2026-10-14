// Shared plumbing for the ZenMoney and Zerro MCP servers.
//
// A Session is one user's context (mirror + remote) with two guarantees: tool calls run one at a
// time, and the mirror is synced when it is older than maxAge. Over HTTP the user is whoever owns
// the ZenMoney token sent with the request (Authorization: Bearer … or X-ZenMoney-Token); each
// token gets its own mirror file named by the token's hash, so the token itself is never stored.
import { createHash } from "node:crypto";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { checkToken, db, makeRemote, sync, type Context } from "@tihonove/zenmoney";

// --------------------------------------------------------------------------------- sessions

export interface Session {
    /** Run `fn` after earlier calls of this session finished, on a mirror synced within maxAge. */
    run<T>(fn: (ctx: Context) => T | Promise<T>): Promise<T>;
}

export interface SessionOptions {
    /** how old the mirror may be before a call syncs it; default 60 s */
    maxAgeMs?: number;
    /** clock, for tests */
    now?: () => number;
}

export function makeSession(
    ctx: Context,
    { maxAgeMs = 60_000, now = Date.now }: SessionOptions = {},
): Session {
    let queue: Promise<unknown> = Promise.resolve();
    let syncedAt = -Infinity;
    return {
        run(fn) {
            const next = queue.then(async () => {
                if (now() - syncedAt > maxAgeMs) {
                    await sync(ctx.con, ctx.remote);
                    syncedAt = now();
                }
                return fn(ctx);
            });
            queue = next.catch(() => undefined);
            return next;
        },
    };
}

export const tokenHash = (token: string): string =>
    createHash("sha256").update(token).digest("hex");

/** The ZenMoney token from request headers: Authorization: Bearer <token>, or X-ZenMoney-Token. */
export function tokenFromHeaders(headers: http.IncomingHttpHeaders): string | null {
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(String(headers.authorization))?.[1];
    const custom = headers["x-zenmoney-token"];
    return bearer ?? (typeof custom === "string" && custom.trim() ? custom.trim() : null);
}

export interface SessionsOptions extends SessionOptions {
    /** where per-token mirrors live */
    dataDir: string;
    /** ZenMoney API base URL */
    api: string;
    /** how long a checked token is trusted; default 10 min */
    tokenTtlMs?: number;
}

/** Sessions by token. A token is checked with the ZenMoney API before its first use (and after tokenTtlMs). */
export class Sessions {
    readonly #options: SessionsOptions;
    readonly #sessions = new Map<string, { session: Session; checkedAt: number }>();

    constructor(options: SessionsOptions) {
        this.#options = options;
        mkdirSync(options.dataDir, { recursive: true });
    }

    /**
     * The session for a token, or null if ZenMoney rejects the token. A rejected (e.g. revoked) token's
     * session and cached mirror are dropped.
     */
    async forToken(token: string): Promise<Session | null> {
        const { api, dataDir, tokenTtlMs = 600_000, now = Date.now } = this.#options;
        const key = tokenHash(token);
        const known = this.#sessions.get(key);
        if (known && now() - known.checkedAt <= tokenTtlMs) return known.session;

        const file = path.join(dataDir, `${key}.db`);
        const remote = makeRemote({ api, token });
        if (!(await checkToken(remote))) {
            this.#sessions.delete(key);
            rmSync(file, { force: true });
            return null;
        }
        const session = known?.session ?? makeSession({ con: db(file), remote }, this.#options);
        this.#sessions.set(key, { session, checkedAt: now() });
        return session;
    }
}

// ---------------------------------------------------------------------------- tool results

/** A tool result with JSON text (and the same value as structured content for objects). */
export function jsonResult(value: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text: message }] };
}

/**
 * Run a tool body; expected errors (not found, bad input, API refused) become an error result the
 * model can read, anything else propagates as a protocol error.
 */
export async function toolCall(fn: () => unknown): Promise<CallToolResult> {
    try {
        return jsonResult(await fn());
    } catch (e) {
        if (e instanceof Error && (e as { userFacing?: unknown }).userFacing === true)
            return errorResult(e.message);
        throw e;
    }
}

// ------------------------------------------------------------------------------------ http

export interface HttpOptions {
    /** builds an MCP server for one request, bound to the caller's session */
    createServer: (session: Session) => McpServer;
    sessions: Pick<Sessions, "forToken">;
    /** default "/mcp" */
    path?: string;
}

const send = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
};

const rpcError = (message: string) => ({
    jsonrpc: "2.0",
    error: { code: -32001, message },
    id: null,
});

/**
 * A stateless Streamable HTTP MCP endpoint: POST <path> with the ZenMoney token in a header.
 * GET /healthz answers "ok" for probes. Every request gets a fresh server bound to its session.
 */
export function createHttpServer({
    createServer,
    sessions,
    path: endpoint = "/mcp",
}: HttpOptions): http.Server {
    return http.createServer(async (req, res) => {
        // An http.Server request always has a url.
        const url = new URL(req.url!, "http://localhost");
        if (url.pathname === "/healthz") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
        }
        if (url.pathname !== endpoint) return send(res, 404, rpcError("not found"));
        if (req.method !== "POST")
            return send(res, 405, rpcError("method not allowed"), { Allow: "POST" });

        const token = tokenFromHeaders(req.headers);
        if (!token) {
            return send(
                res,
                401,
                rpcError(
                    "ZenMoney token required: Authorization: Bearer <token> or X-ZenMoney-Token",
                ),
                {
                    "WWW-Authenticate": "Bearer",
                },
            );
        }
        const session = await sessions.forToken(token);
        if (!session)
            return send(res, 401, rpcError("ZenMoney rejected the token"), {
                "WWW-Authenticate": "Bearer",
            });

        const server = createServer(session);
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
        });
        res.on("close", () => {
            void transport.close();
            void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res);
    });
}

/** Server settings from the environment: PORT (8080), HOST (0.0.0.0), DATA_DIR (./data), ZENMONEY_API. */
export function httpConfig(env: Record<string, string | undefined> = process.env) {
    return {
        port: Number(env.PORT || 8080),
        host: env.HOST || "0.0.0.0",
        dataDir: path.resolve(env.DATA_DIR || "data"),
        api: env.ZENMONEY_API || "https://api.zenmoney.ru",
    };
}

// Process glue for bin/ scripts: it only runs in a real process, which the smoke tests start;
// neither v8 coverage nor Stryker see into that subprocess.
/* v8 ignore start */
// Stryker disable all

/** stdio server for a local MCP client: one user, configured like the CLIs (ZENMONEY_DB, ZENMONEY_TOKEN…). */
export async function serveStdio(createServer: (session: Session) => McpServer): Promise<void> {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { open, envConfig } = await import("@tihonove/zenmoney");
    const server = createServer(makeSession(open(envConfig())));
    await server.connect(new StdioServerTransport());
}

/** HTTP server for many users (see httpConfig); stops gracefully on SIGTERM / SIGINT. */
export function serveHttp(
    name: string,
    createServer: (session: Session) => McpServer,
): http.Server {
    const config = httpConfig();
    const sessions = new Sessions({ dataDir: config.dataDir, api: config.api });
    const server = createHttpServer({ createServer, sessions });
    server.listen(config.port, config.host, () =>
        console.log(`${name}: listening on ${config.host}:${config.port}`),
    );
    for (const signal of ["SIGTERM", "SIGINT"] as const)
        process.on(signal, () => server.close(() => process.exit(0)));
    return server;
}
// Stryker restore all
/* v8 ignore stop */
