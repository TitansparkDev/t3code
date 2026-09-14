import { memo } from "react";
import type { ThreadUsageLimitResume } from "@t3tools/contracts";
import { isProviderRateLimitFailure } from "@t3tools/shared/providerRateLimit";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key plus message, so navigating away to a thread
// with no error cannot resurrect the banner, while a different error message
// on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export function isProviderRateLimitError(error: string): boolean {
  return isProviderRateLimitFailure(error);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  usageLimitResume,
  onScheduleUsageLimitResume,
  onResumeNowUsageLimit,
  onCancelUsageLimitResume,
  usageLimitResumePending,
}: {
  error: string | null;
  onDismiss?: (() => void) | undefined;
  usageLimitResume?: ThreadUsageLimitResume | null | undefined;
  onScheduleUsageLimitResume?: (() => void) | undefined;
  onResumeNowUsageLimit?: (() => void) | undefined;
  onCancelUsageLimitResume?: (() => void) | undefined;
  usageLimitResumePending?: boolean | undefined;
}) {
  if (!error) return null;
  const showUsageLimitResume = isProviderRateLimitError(error) || usageLimitResume !== undefined;
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert
        variant="error"
        controlAlignment="first-line"
        className="alert-glass"
        data-variant="error"
      >
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
          {showUsageLimitResume && (
            <div className="mt-1 text-xs text-muted-foreground">
              {usageLimitResume?.nextAttemptAt === null
                ? "Resuming automatically…"
                : usageLimitResume?.nextAttemptAt !== undefined
                  ? `Will resume at ${new Date(usageLimitResume.nextAttemptAt).toLocaleTimeString(
                      [],
                      {
                        hour: "numeric",
                        minute: "2-digit",
                      },
                    )}.`
                  : "Resume automatically after the provider reset window."}
            </div>
          )}
        </AlertDescription>
        {(onScheduleUsageLimitResume ||
          onResumeNowUsageLimit ||
          onCancelUsageLimitResume ||
          onDismiss) && (
          <AlertAction className="flex items-center gap-1">
            {usageLimitResume?.nextAttemptAt === null ? null : (
              <>
                {onResumeNowUsageLimit && (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Resume now"
                    disabled={usageLimitResumePending}
                    onClick={onResumeNowUsageLimit}
                  >
                    Resume now
                  </Button>
                )}
                {usageLimitResume?.nextAttemptAt
                  ? onCancelUsageLimitResume && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Cancel automatic resume"
                        disabled={usageLimitResumePending}
                        onClick={onCancelUsageLimitResume}
                      >
                        Cancel
                      </Button>
                    )
                  : onScheduleUsageLimitResume && (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="Resume automatically"
                        disabled={usageLimitResumePending}
                        onClick={onScheduleUsageLimitResume}
                      >
                        Resume automatically
                      </Button>
                    )}
              </>
            )}
            {onDismiss && (
              <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
                <XIcon className="text-destructive" />
              </Button>
            )}
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
