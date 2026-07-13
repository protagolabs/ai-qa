#!/usr/bin/env node
import { createDefaultContext } from "./context.js";
import { runCli } from "./program.js";

process.exitCode = await runCli(process.argv.slice(2), createDefaultContext());
