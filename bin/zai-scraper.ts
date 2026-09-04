#!/usr/bin/env bun

import process from "node:process";
import { main } from "../src/zai-to-markdown.ts";

process.exitCode = await main();
