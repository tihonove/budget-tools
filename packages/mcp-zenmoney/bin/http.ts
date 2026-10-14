#!/usr/bin/env node
// MCP over HTTP for many users: the ZenMoney token comes with each request (PORT, HOST, DATA_DIR, ZENMONEY_API).
import { serveHttp } from "@tihonove/mcp-kit";
import { createZenmoneyServer } from "../src/index.ts";

serveHttp("mcp-zenmoney", createZenmoneyServer);
