/**
 * A `TextGeneration` service for drivers that cannot serve background text
 * generation.
 *
 * Some provider CLIs can only produce text as a full agent turn — an
 * interactive session on the user's own account. Running one to name a commit
 * is wasteful and surprising, so those drivers declare
 * `supportsTextGeneration: false` on their snapshot and hand the registry this
 * stub. Reaching for it anyway is a configuration error with a clear cause
 * rather than a silent fallback to a different provider's model.
 */
import { type ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGeneration } from "./TextGeneration.ts";

const reject =
  (driverKind: ProviderDriverKind) =>
  (operation: string): Effect.Effect<never, TextGenerationError> =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: `${driverKind} does not support background text generation. Pick another provider for titles, branch names, commit messages and pull request descriptions.`,
      }),
    );

export const makeUnsupportedTextGeneration = (
  driverKind: ProviderDriverKind,
): TextGeneration["Service"] => {
  const fail = reject(driverKind);
  return {
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  };
};
