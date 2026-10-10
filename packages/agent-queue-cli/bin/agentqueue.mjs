#!/usr/bin/env node
import { runCli } from "../src/cli.ts";

const rawArgs = process.argv.slice(2);
const { exitCode, output } = runCli(rawArgs);

if (output) {
  if (exitCode === 0) {
    process.stdout.write(output + "\n");
  } else {
    process.stderr.write(output + "\n");
  }
}

process.exit(exitCode);
