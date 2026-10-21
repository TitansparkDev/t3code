import { assert, it } from "@effect/vitest";

import { candidateDirectory, sha256 } from "./reliability-artifact-smoke.ts";

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
