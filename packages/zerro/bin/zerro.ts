#!/usr/bin/env node
import { runMain } from "@tihonove/cli-kit";
import { main } from "../src/cli.ts";

await runMain(main);
