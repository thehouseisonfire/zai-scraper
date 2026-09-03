#!/usr/bin/env bun

import { main } from "../src/zai-to-markdown.ts";

process.exitCode = await main();
