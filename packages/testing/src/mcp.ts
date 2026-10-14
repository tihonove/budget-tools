// MCP test helpers: an SDK client connected to a server in memory.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolCall {
    isError: boolean;
    /** the text content, parsed as JSON when it is JSON */
    value: unknown;
    text: string;
}

export interface TestClient {
    client: Client;
    call(name: string, args?: Record<string, unknown>): Promise<ToolCall>;
    close(): Promise<void>;
}

export async function connect(server: McpServer): Promise<TestClient> {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    return {
        client,
        async call(name, args = {}) {
            const result = await client.callTool({ name, arguments: args });
            const text = (result.content as { type: string; text: string }[])[0]!.text;
            let value: unknown = text;
            try {
                value = JSON.parse(text);
            } catch {
                // plain text
            }
            return { isError: result.isError === true, value, text };
        },
        close: () => client.close(),
    };
}
