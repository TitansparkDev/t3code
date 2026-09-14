import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const forkThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:commands:thread:fork",
  tag: WS_METHODS.threadsFork,
});

export const forkThreadTargetAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-fork-thread-target"),
);

export function openForkThread(thread: EnvironmentThreadShell): void {
  appAtomRegistry.set(forkThreadTargetAtom, thread);
}

export function closeForkThread(): void {
  appAtomRegistry.set(forkThreadTargetAtom, null);
}
