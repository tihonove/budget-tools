// Smoke tests of the real bin/ scripts: stdio and HTTP servers as processes, SDK clients talking to them.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test } from "vitest";
import { fixture, startHttpBin, stdioClient, syncedSandbox } from "@tihonove/testing";
import { tokenHash } from "@tihonove/mcp-kit";

const bin = (name: string) =>
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin", name);
const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

test("stdio: a local client lists tools and reads the envelopes", async () => {
    const sb = await syncedSandbox();
    onTestFinished(() => sb.close());
    const client = await stdioClient(bin("stdio.ts"), sb.env);
    onTestFinished(() => client.close());

    expect((await client.listTools()).tools.length).toBe(8);
    const envelopes = JSON.parse(text(await client.callTool({ name: "envelopes", arguments: {} })));
    expect(envelopes[0].id).toBe("tag#null");
});

test("http: the token from the header picks the user's mirror; no token → 401", async () => {
    const sb = await syncedSandbox([
        { user: fixture("account.json").user },
        fixture("account.json"),
    ]);
    onTestFinished(() => sb.close());
    const server = await startHttpBin(bin("http.ts"), { ZENMONEY_API: sb.api.url });
    onTestFinished(() => server.stop());

    expect((await fetch(`${server.url}/mcp`, { method: "POST" })).status).toBe(401);

    const client = await server.client({ Authorization: "Bearer live-token" });
    onTestFinished(() => client.close());
    const envelopes = JSON.parse(text(await client.callTool({ name: "envelopes", arguments: {} })));
    expect(envelopes.length).toBe(5);
    expect(sb.api.requests.map((r) => r.auth)).toEqual(["Bearer live-token", "Bearer live-token"]);
    expect(existsSync(path.join(server.dataDir, `${tokenHash("live-token")}.db`))).toBe(true);
});
