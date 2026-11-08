import { assert, it } from "@effect/vitest";

import { candidateDirectory, requiredNodeVersion, sha256 } from "./reliability-artifact-smoke.ts";

it("takes the build Node version from the root engines pin", () => {
  assert.equal(requiredNodeVersion(JSON.stringify({ engines: { node: "26.12.1" } })), "26.12.1");
  assert.throws(() => requiredNodeVersion(JSON.stringify({ engines: { node: "^26" } })));
  assert.throws(() => requiredNodeVersion(JSON.stringify({})));
});

it("keys retained candidates by exact revision and version", () => {
  assert.equal(
    candidateDirectory("/tmp/artifacts", "0.1.3", "abc123"),
    "/tmp/artifacts/candidates/0.1.3-abc123",
  );
  assert.notEqual(
    candidateDirectory("/tmp/artifacts", "0.1.3", "abc123"),
    candidateDirectory("/tmp/artifacts", "0.1.3", "def456"),
  );
});

it("records a stable SHA-256 digest for artifact bytes", () => {
  assert.equal(
    sha256(Buffer.from("candidate")),
    "dda18a0e21ae47c53b4309434cbc02ae8bf764fa83a6defbb719431242722aa7",
  );
});
