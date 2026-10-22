import type { EnvironmentId } from "@t3tools/contracts";
import { resolveUsageAccess } from "@t3tools/client-runtime/state/usage-access";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type {
  UsageBannerEntry,
  UsageBannerPresentations,
} from "../features/usage/usage-banner-model";
import { environmentPresentations } from "./presentation";
import { environmentSession } from "./session";

function sameEnvironments(
  left: UsageBannerPresentations,
  right: UsageBannerPresentations,
): boolean {
  if (left.size !== right.size) return false;
  for (const [environmentId, presentation] of left) {
    if (right.get(environmentId) !== presentation) return false;
  }
  return true;
}

/**
 * Environments whose limits the strip may show: the same diagnostics-read rule the Usage screen
 * applies (`AuthDiagnosticsReadScope` on the live session). A failed or missing session drops the
 * environment's values outright rather than keeping them as stale.
 *
 * Reads only the presentation and session atoms. It never touches the usage summary query, so
 * mounting the strip emits no usage RPC and no transcript scan.
 */
export const usageBannerPresentationsAtom = Atom.make((get): UsageBannerPresentations => {
  const previous = Option.getOrNull(get.self<UsageBannerPresentations>());
  const next = new Map<EnvironmentId, UsageBannerEntry>();
  for (const [environmentId, presentation] of get(
    environmentPresentations.presentationsWithProvidersAtom,
  )) {
    const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
    const access = resolveUsageAccess({
      connectionPhase: presentation.connection.phase,
      session: Option.getOrNull(AsyncResult.value(sessionResult)),
      hasSessionError: sessionResult._tag === "Failure",
    });
    if (access.canReadDiagnostics) next.set(environmentId, presentation);
  }
  return previous !== null && sameEnvironments(previous, next) ? previous : next;
}).pipe(Atom.withLabel("mobile-usage-banner-presentations"));
