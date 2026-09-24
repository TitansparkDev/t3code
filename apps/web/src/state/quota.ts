/**
 * Live subscription-quota state across connected environments.
 *
 * Provider instance ids are environment-local routing keys. Keep environment
 * identity beside every snapshot instead of flattening `codex` from two
 * machines into one apparently authoritative account.
 *
 * @module state/quota
 */
import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  QUOTA_CONTRACT_VERSION,
  type AccountQuotaSnapshot,
  type QuotaSummary,
} from "@t3tools/contracts/quota";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

interface EnvironmentQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly isPending: boolean;
  readonly summary: QuotaSummary | null;
}

const quotaAtom = Atom.make((get): readonly EnvironmentQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const statuses: EnvironmentQuotaStatus[] = [];
  for (const [environmentId] of presentations) {
    const result = get(serverEnvironment.quota({ environmentId, input: {} }));
    const summary = Option.getOrNull(AsyncResult.value(result));
    statuses.push({
      environmentId,
      isPending: result.waiting,
      summary: summary?.contractVersion === QUOTA_CONTRACT_VERSION ? summary : null,
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-quota"));

export interface EnvironmentQuotaSnapshot {
  readonly environmentId: EnvironmentId;
  readonly snapshot: AccountQuotaSnapshot;
}

export interface QuotaView {
  readonly snapshots: readonly EnvironmentQuotaSnapshot[];
  readonly byEnvironment: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<ProviderInstanceId, AccountQuotaSnapshot>
  >;
  readonly isPending: boolean;
  readonly isSettling: boolean;
  readonly isRefreshing: boolean;
  readonly refresh: () => void;
}

export function useQuota(): QuotaView {
  const environments = useAtomValue(quotaAtom);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const list: readonly EnvironmentQuotaStatus[] = Array.isArray(environments) ? environments : [];
  const snapshots = useMemo(
    () =>
      list.flatMap((environment) =>
        (environment.summary?.snapshots ?? []).map((snapshot) => ({
          environmentId: environment.environmentId,
          snapshot,
        })),
      ),
    [environments],
  );

  const byEnvironment = useMemo(() => {
    const result = new Map<EnvironmentId, ReadonlyMap<ProviderInstanceId, AccountQuotaSnapshot>>();
    for (const environment of list) {
      result.set(
        environment.environmentId,
        new Map(
          (environment.summary?.snapshots ?? []).map(
            (snapshot) => [snapshot.providerInstanceId, snapshot] as const,
          ),
        ),
      );
    }
    return result;
  }, [environments]);

  const refresh = useCallback(() => {
    if (isRefreshing || list.length === 0) return;

    setIsRefreshing(true);
    const refreshes = list.map((environment) => {
      const target = { environmentId: environment.environmentId, input: {} };
      return runAtomCommand(appAtomRegistry, serverEnvironment.refreshProviders, target, {
        label: "refresh account limits",
        reportFailure: false,
        reportDefect: false,
      }).then(() => {
        appAtomRegistry.refresh(serverEnvironment.quota(target));
      });
    });

    void Promise.allSettled(refreshes).then(() => setIsRefreshing(false));
  }, [environments, isRefreshing]);

  const answered = list.filter((environment) => environment.summary !== null).length;
  const stillReporting = list.filter(
    (environment) => environment.summary === null && environment.isPending,
  ).length;

  return {
    snapshots,
    byEnvironment,
    isPending: answered === 0 && stillReporting > 0,
    isSettling: stillReporting > 0,
    isRefreshing,
    refresh,
  };
}
