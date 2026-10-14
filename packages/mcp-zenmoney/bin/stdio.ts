#!/usr/bin/env node
// MCP over stdio for a local client (Claude Code): configured like the CLIs (ZENMONEY_DB, ZENMONEY_TOKEN, …).
import { serveStdio } from "@tihonove/mcp-kit";
import { createZenmoneyServer } from "../src/index.ts";

await serveStdio(createZenmoneyServer);
