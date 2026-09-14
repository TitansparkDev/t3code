import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

export function canRefreshProviders(connectionState: EnvironmentConnectionPhase): boolean {
  return connectionState === "connected";
}

export function providerRefreshAlert(
  result: AtomCommandResult<unknown, unknown>,
): { readonly title: string; readonly message: string } | null {
  if (result._tag === "Success") {
    return {
      title: "Providers refreshed",
      message: "Provider availability and model metadata are up to date.",
    };
  }
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return {
    title: "Could not refresh providers",
    message: error instanceof Error ? error.message : "The provider status could not be refreshed.",
  };
}

export function createProviderRefreshRunner(
  onRefresh: () => Promise<AtomCommandResult<unknown, unknown>>,
  onAlert: (alert: { readonly title: string; readonly message: string }) => void,
): () => Promise<void> | null {
  let pending: Promise<void> | null = null;

  return () => {
    if (pending) return null;
    const run = async () => {
      const alert = providerRefreshAlert(await onRefresh());
      if (alert) onAlert(alert);
    };
    pending = run().finally(() => {
      pending = null;
    });
    return pending;
  };
}
