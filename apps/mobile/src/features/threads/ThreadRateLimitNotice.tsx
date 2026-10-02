import { isProviderRateLimitFailure } from "@t3tools/shared/providerRateLimit";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";

/** Why the thread's last turn could not run, shown above the composer. */
export const ThreadRateLimitNotice = memo(function ThreadRateLimitNotice({
  error,
  status,
}: {
  readonly error: string | null;
  readonly status: "rate-limited" | "error";
}) {
  const rateLimited =
    status === "rate-limited" || (error !== null && isProviderRateLimitFailure(error));

  return (
    <View
      accessibilityRole="alert"
      className="mx-4 mb-2 rounded-2xl border border-danger-border bg-danger-subtle px-3.5 py-3"
    >
      <Text className="text-sm font-t3-bold text-danger-foreground">
        {rateLimited ? "Usage limit reached" : "The agent could not run"}
      </Text>
      {error ? (
        <Text className="mt-1 text-xs leading-5 text-danger-foreground">{error}</Text>
      ) : null}
      <Text className="mt-1 text-xs leading-5 text-foreground-muted">
        {rateLimited
          ? "Wait for the provider reset window, then send a new message to resume this thread."
          : "Send the message again to retry."}
      </Text>
    </View>
  );
});
