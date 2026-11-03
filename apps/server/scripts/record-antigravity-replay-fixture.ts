#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Converts an existing Antigravity ACP protocol-log capture into a sanitized replay
 * transcript. It never starts Antigravity or any other provider, and it never reads
 * credential stores. The capture is the native protocol logger's output from a run
 * the operator made themselves, in a disposable workspace.
 *
 *   node --experimental-strip-types scripts/record-antigravity-replay-fixture.ts \
 *     --capture <protocol-capture.ndjson> --out <replay.ndjson> \
 *     [--workspace <disposable-dir>] [--scenario <name>] [--secret-env <ENV_NAME>]...
 *
 * Without --capture the script prints this usage and exits 0. --workspace must
 * contain a `.t3-disposable-replay` marker, so a real project is never recorded.
 * --secret-env names an environment variable whose value is redacted from the output;
 * the value itself is never printed. --out is created exclusively and never overwritten.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  replayEntriesFromProtocolCapture,
  sanitizeReplayValue,
  type ProtocolCaptureRecord,
} from "../../../packages/provider-testing/src/replayTranscript.ts";

const DISPOSABLE_MARKER = ".t3-disposable-replay";

function argValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const capturePath = argValues("--capture")[0];
if (capturePath === undefined) {
  process.stdout.write(
    "Usage: record-antigravity-replay-fixture.ts --capture <protocol-capture.ndjson> --out <replay.ndjson> [--workspace <disposable-dir>] [--scenario <name>] [--secret-env <ENV>]\n" +
      "No provider is started. Provide a capture written by the native ACP protocol logger.\n",
  );
  process.exit(0);
}

const outPath = argValues("--out")[0];
if (outPath === undefined) fail("--out is required.");
if (NodePath.resolve(outPath) === NodePath.resolve(capturePath)) {
  fail("--out must differ from --capture.");
}
if (NodeFS.existsSync(outPath)) {
  fail("--out already exists; recordings are never overwritten.");
}

const workspace = argValues("--workspace")[0];
if (workspace !== undefined) {
  if (!NodeFS.existsSync(NodePath.join(workspace, DISPOSABLE_MARKER))) {
    fail(
      `--workspace must contain ${DISPOSABLE_MARKER}; refusing to record a non-disposable directory.`,
    );
  }
}

const secrets = argValues("--secret-env").flatMap((name) => {
  const value = process.env[name];
  return value === undefined || value.length === 0 ? [] : [value];
});

const scenario = argValues("--scenario")[0] ?? "antigravity_recorded";
const records = NodeFS.readFileSync(capturePath, "utf8")
  .split(/\r?\n/u)
  .filter((line) => line.trim().length > 0)
  .map((line): ProtocolCaptureRecord => {
    const parsed = JSON.parse(line) as ProtocolCaptureRecord;
    if (
      (parsed.direction !== "incoming" && parsed.direction !== "outgoing") ||
      typeof parsed.payload !== "string"
    ) {
      fail("Capture records must be {direction, payload} protocol-logger events.");
    }
    return parsed;
  });

const { entries, unparsedLines } = replayEntriesFromProtocolCapture(records, {
  ...(workspace === undefined ? {} : { workspace: NodePath.resolve(workspace) }),
  secrets,
});
if (entries.length === 0) fail("The capture contains no replayable ACP frames.");

const header = sanitizeReplayValue({
  type: "transcript_start",
  provider: "antigravity",
  protocol: "acp.ndjson-jsonrpc",
  version: "1",
  scenario,
  metadata: {
    generatedBy: "recorded-native-protocol-log",
    normalization:
      "Outbound T3 params are <any>. Workspace paths are <workspace>. Credentials, login URLs, account identifiers and attachment bytes are redacted.",
    unparsedCaptureLines: unparsedLines,
  },
});
const text = [header, ...entries]
  .map((record) => JSON.stringify(sanitizeReplayValue(record, { secrets })))
  .join("\n");
NodeFS.writeFileSync(outPath, `${text}\n`, { flag: "wx" });
process.stdout.write(`Wrote ${entries.length} replay entries.\n`);
