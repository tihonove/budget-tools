// Smoke-test helpers for MCP bin/ scripts: start them as real processes and talk to them with the SDK.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const freePort = () =>
    new Promise<number>((resolve) => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number };
            probe.close(() => resolve(port));
        });
    });

/** An SDK client connected to a stdio MCP bin. */
export async function stdioClient(bin: string, env: Record<string, string>): Promise<Client> {
    const client = new Client({ name: "smoke", version: "1" });
    await client.connect(
        new StdioClientTransport({
            command: process.execPath,
            args: [bin],
            env: { ...process.env, ...env } as Record<string, string>,
        }),
    );
    return client;
}

export interface HttpBin {
    url: string;
    dataDir: string;
    process: ChildProcess;
    /** an SDK client sending the token in a header */
    client(headers: Record<string, string>): Promise<Client>;
    stop(): Promise<void>;
}

/** Start an HTTP MCP bin on a free port and wait for /healthz. */
export async function startHttpBin(bin: string, env: Record<string, string>): Promise<HttpBin> {
    const port = await freePort();
    const dataDir = path.join(mkdtempSync(path.join(tmpdir(), "mcp-bin-")), "data");
    const child = spawn(process.execPath, [bin], {
        env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dataDir },
        stdio: "ignore",
    });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; ; i++) {
        try {
            if ((await fetch(`${url}/healthz`)).ok) break;
        } catch {
            if (i > 100) throw new Error(`${bin} did not start`);
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    return {
        url,
        dataDir,
        process: child,
        async client(headers) {
            const client = new Client({ name: "smoke", version: "1" });
            await client.connect(
                new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
                    requestInit: { headers },
                }),
            );
            return client;
        },
        stop: () =>
            new Promise((resolve) => {
                child.once("exit", () => resolve());
                child.kill("SIGTERM");
            }),
    };
}
