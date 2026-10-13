#!/usr/bin/env node
import { runCliAsync } from "../src/cli.ts";

const rawArgs = process.argv.slice(2);
const { exitCode, output, error } = await runCliAsync(rawArgs);

if (output) {
  if (exitCode === 0) {
    process.stdout.write(output + "\n");
  } else {
    process.stderr.write(output + "\n");
  }
}
if (error) process.stderr.write(error + "\n");

process.exit(exitCode);
