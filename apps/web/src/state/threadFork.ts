import { WS_METHODS, type ScopedThreadRef } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const forkThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:commands:thread:fork",
  tag: WS_METHODS.threadsFork,
});

export const forkThreadDialogTargetAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-fork-thread-dialog-target"),
);

export function openForkThreadDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(forkThreadDialogTargetAtom, threadRef);
}

export function closeForkThreadDialog(): void {
  appAtomRegistry.set(forkThreadDialogTargetAtom, null);
}
