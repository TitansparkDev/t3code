/**
 * Goals, per connected environment.
 *
 * A goal belongs to the machine that runs its chats, so goals are never merged
 * across environments. Chats finish on the server without a client asking, so
 * the list is refreshed on a timer while a page that shows it is mounted.
 *
 * @module state/goals
 */
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Goal, GoalId } from "@t3tools/contracts/goals";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentGoals {
  readonly environmentId: EnvironmentId;
  readonly goals: ReadonlyArray<Goal>;
  readonly isPending: boolean;
}

const goalsAtom = Atom.make((get): readonly EnvironmentGoals[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentGoals[] = [];
  for (const [environmentId] of presentations) {
    const result = get(serverEnvironment.goals({ environmentId, input: {} }));
    const value = Option.getOrNull(AsyncResult.value(result));
    statuses.push({ environmentId, goals: value?.goals ?? [], isPending: result.waiting });
  }
  return statuses;
}).pipe(Atom.withLabel("web-goals"));

const REFRESH_MS = 5_000;

export function useGoals() {
  const environments = useAtomValue(goalsAtom);

  const refresh = useCallback((environmentId: EnvironmentId) => {
    appAtomRegistry.refresh(serverEnvironment.goals({ environmentId, input: {} }));
  }, []);

  const command = useCallback(
    (
      atom:
        | typeof serverEnvironment.stopGoal
        | typeof serverEnvironment.restartGoal
        | typeof serverEnvironment.deleteGoal,
      label: string,
    ) =>
      async (environmentId: EnvironmentId, id: GoalId) => {
        await runAtomCommand(appAtomRegistry, atom, { environmentId, input: { id } }, { label });
        refresh(environmentId);
      },
    [refresh],
  );
  const stop = useMemo(() => command(serverEnvironment.stopGoal, "stop goal"), [command]);
  const restart = useMemo(() => command(serverEnvironment.restartGoal, "restart goal"), [command]);
  const remove = useMemo(() => command(serverEnvironment.deleteGoal, "delete goal"), [command]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      for (const environment of environments) refresh(environment.environmentId);
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [environments, refresh]);

  return useMemo(
    () => ({ environments, stop, restart, remove }),
    [environments, stop, restart, remove],
  );
}
