#!/usr/bin/env node
import { connectCli } from "./cli";

// The entry of the `creatortoolset` command (package.json bin, built to dist/cli.js).
connectCli(process.argv.slice(2), {
  log: (line) => console.log(line),
  err: (line) => console.error(line),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}).then((code) => process.exit(code));
