#!/usr/bin/env node
import { runCliAsync } from "../src/cli.ts";

const rawArgs = process.argv.slice(2);
const { exitCode, output, error } = await runCliAsync(rawArgs);

// Writes to a pipe are asynchronous: exiting straight after them cut piped JSON off at 64 KB.
const write = (stream, text) => new Promise((resolve) => stream.write(text, () => resolve()));

if (output) await write(exitCode === 0 ? process.stdout : process.stderr, output + "\n");
if (error) await write(process.stderr, error + "\n");

process.exit(exitCode);
