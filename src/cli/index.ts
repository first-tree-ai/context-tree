#!/usr/bin/env node

import { runContextTreeCli } from "./api.js";

process.exitCode = await runContextTreeCli();
