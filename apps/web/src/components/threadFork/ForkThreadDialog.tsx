import { GitForkIcon, CheckIcon, CircleAlertIcon, Loader2Icon } from "lucide-react";
import { useState, useMemo, useEffect, useCallback } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import type { ModelSelection, ScopedThreadRef } from "@t3tools/contracts";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useServerConfigs, useThreadShell } from "~/state/entities";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { buildThreadRouteParams } from "~/threadRoutes";
import { newThreadId, cn } from "~/lib/utils";
import {
  closeForkThreadDialog,
  forkThreadCommand,
  forkThreadDialogTargetAtom,
} from "~/state/threadFork";
import {
  defaultForkTitle,
  formatForkErrorMessage,
  resolveDefaultForkSelection,
  resolveForkModelOptions,
  type ForkModelOption,
} from "~/threadFork.logic";

export function ForkThreadDialogHost() {
  const targetRef = useAtomValue(forkThreadDialogTargetAtom);
  if (targetRef === null) return null;
  return (
    <ForkThreadDialog
      open
      threadRef={targetRef}
      onOpenChange={(open) => {
        if (!open) closeForkThreadDialog();
      }}
    />
  );
}

export function ForkThreadDialog(props: {
  readonly open: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenChange: (open: boolean) => void;
  readonly onForkSuccess?: (targetThreadId: string) => void;
}) {
  const { open, threadRef, onOpenChange, onForkSuccess } = props;
  const router = useRouter();
  const thread = useThreadShell(threadRef);
  const serverConfigs = useServerConfigs();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const forkThreadMutation = useAtomCommand(forkThreadCommand, { reportFailure: false });

  const serverConfig = serverConfigs.get(threadRef.environmentId);
  const forkOptions = useMemo(
    () =>
      resolveForkModelOptions({
        providers: serverConfig?.providers ?? [],
        settings,
        ...(thread?.modelSelection ? { sourceModelSelection: thread.modelSelection } : {}),
      }),
    [serverConfig?.providers, settings, thread?.modelSelection],
  );

  const [selectedOption, setSelectedOption] = useState<ForkModelOption | null>(null);
  const [title, setTitle] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSelectedOption(resolveDefaultForkSelection(forkOptions, thread?.modelSelection));
      setTitle(defaultForkTitle(thread?.title ?? ""));
      setIsSubmitting(false);
      setError(null);
    }
  }, [open, forkOptions, thread?.modelSelection, thread?.title]);

  const handleFork = useCallback(async () => {
    if (isSubmitting || !selectedOption || !thread) return;
    setIsSubmitting(true);
    setError(null);

    const targetThreadId = newThreadId();
    const modelSelection: ModelSelection = {
      instanceId: selectedOption.instanceId,
      model: selectedOption.modelSlug,
    };

    const trimmedTitle = title.trim();
    const result = await forkThreadMutation({
      environmentId: threadRef.environmentId,
      input: {
        projectId: thread.projectId,
        sourceThreadId: thread.id,
        targetThreadId,
        modelSelection,
        ...(trimmedTitle ? { title: trimmedTitle } : {}),
      },
    });

    if (result._tag === "Failure") {
      setIsSubmitting(false);
      if (!isAtomCommandInterrupted(result)) {
        const err = squashAtomCommandFailure(result);
        setError(formatForkErrorMessage(err));
      }
      return;
    }

    setIsSubmitting(false);
    onOpenChange(false);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: "Thread forked",
        description: `Created new thread from "${thread.title}".`,
      }),
    );
    const destinationThreadId = result.value.threadId ?? targetThreadId;
    if (onForkSuccess) {
      onForkSuccess(destinationThreadId);
    }
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, destinationThreadId)),
    });
  }, [
    forkThreadMutation,
    isSubmitting,
    onForkSuccess,
    onOpenChange,
    router,
    selectedOption,
    thread,
    threadRef.environmentId,
    title,
  ]);

  return (
    <Dialog open={open} onOpenChange={(next) => (isSubmitting ? undefined : onOpenChange(next))}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitForkIcon className="size-5 text-primary" />
            Fork conversation
          </DialogTitle>
          <DialogDescription>
            {thread?.title
              ? `Fork "${thread.title}" to continue with a different model or provider.`
              : "Fork this thread to continue with a different model or provider."}{" "}
            The original thread will remain untouched.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {error && (
            <Alert variant="error" data-variant="error">
              <CircleAlertIcon />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-1.5">
            <label
              htmlFor="fork-thread-title"
              className="text-xs font-medium text-muted-foreground"
            >
              Thread title
            </label>
            <Input
              id="fork-thread-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="New thread title"
              disabled={isSubmitting}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void handleFork();
                }
              }}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Target provider &amp; model
            </label>
            {forkOptions.length === 0 ? (
              <p className="rounded-lg border border-border/70 bg-muted/40 p-4 text-sm text-muted-foreground">
                No available provider accounts or models were found.
              </p>
            ) : (
              <div
                className="max-h-60 overflow-y-auto space-y-1.5 rounded-lg border border-border/70 p-2"
                role="listbox"
                aria-label="Target models"
              >
                {forkOptions.map((option) => {
                  const isSelected =
                    selectedOption?.instanceId === option.instanceId &&
                    selectedOption?.modelSlug === option.modelSlug;
                  return (
                    <button
                      key={`${option.instanceId}:${option.modelSlug}`}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      disabled={isSubmitting}
                      className={cn(
                        "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                        isSelected
                          ? "bg-accent text-accent-foreground font-medium border border-primary/40"
                          : "hover:bg-muted/60 text-foreground border border-transparent",
                        isSubmitting && "opacity-60 cursor-not-allowed",
                      )}
                      onClick={() => setSelectedOption(option)}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{option.modelName}</span>
                          {option.isCurrent && (
                            <Badge variant="secondary" className="text-[10px] py-0 px-1.5">
                              Current
                            </Badge>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {option.providerDisplayName}
                        </div>
                      </div>
                      {isSelected && <CheckIcon className="size-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void handleFork()}
            disabled={isSubmitting || !selectedOption}
          >
            {isSubmitting ? (
              <>
                <Loader2Icon className="size-4 animate-spin" />
                Forking…
              </>
            ) : (
              <>
                <GitForkIcon className="size-4" />
                Fork thread
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
