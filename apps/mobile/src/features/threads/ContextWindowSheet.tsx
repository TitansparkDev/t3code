import { ScrollView, View } from "react-native";
import {
  formatContextWindowCompactionNote,
  formatContextWindowCost,
  formatContextWindowPercentage,
  formatContextWindowTokens,
  formatContextWindowUpdatedAt,
  type ContextWindowSnapshot,
} from "@t3tools/client-runtime/state/contextWindow";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Progress } from "../../components/ui/Progress";
import { Sheet } from "../../components/ui/Sheet";

function UsageRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3 px-4 py-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-sm font-t3-medium tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
}

export function ContextWindowSheet(props: {
  readonly usage: ContextWindowSnapshot;
  readonly modelName: string | null;
  /** Null when compacting is supported and available now. */
  readonly compactDisabledReason: string | null;
  readonly onCompact: () => void;
  readonly onClose: () => void;
}) {
  const { usage } = props;
  const usedPercentage = formatContextWindowPercentage(usage.usedPercentage);
  const windowKnown = usage.maxTokens !== null;
  const updatedAt = formatContextWindowUpdatedAt(usage.updatedAt);
  const note = formatContextWindowCompactionNote(usage, props.modelName);
  const showTotalProcessed = (usage.totalProcessedTokens ?? 0) > 0;
  const compactDisabled = props.compactDisabledReason !== null;

  return (
    <Sheet title="Context window" onClose={props.onClose}>
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 12,
          paddingBottom: 24,
          gap: 16,
        }}
      >
        <View className="gap-3">
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-2xl font-t3-bold tabular-nums text-foreground">
              {usedPercentage ?? formatContextWindowTokens(usage.usedTokens)}
            </Text>
            {windowKnown ? (
              <Text className="text-sm tabular-nums text-foreground-muted">
                {formatContextWindowTokens(usage.usedTokens)}/
                {formatContextWindowTokens(usage.maxTokens ?? null)}
              </Text>
            ) : null}
          </View>
          {windowKnown ? (
            <Progress value={(usage.usedPercentage ?? 0) / 100} label="Context window usage" />
          ) : (
            <Text className="text-sm text-foreground-muted">
              The provider did not report the window size.
            </Text>
          )}
        </View>

        <View className="overflow-hidden rounded-xl bg-grouped-card">
          <UsageRow label="Used" value={formatContextWindowTokens(usage.usedTokens)} />
          {usage.remainingTokens !== null ? (
            <UsageRow label="Free space" value={formatContextWindowTokens(usage.remainingTokens)} />
          ) : null}
          {showTotalProcessed ? (
            <UsageRow
              label="Total processed"
              value={formatContextWindowTokens(usage.totalProcessedTokens ?? null)}
            />
          ) : null}
          {usage.cost != null ? (
            <UsageRow label="Cost" value={formatContextWindowCost(usage.cost)} />
          ) : null}
          {updatedAt ? <UsageRow label="Updated" value={updatedAt} /> : null}
        </View>

        {note ? <Text className="text-sm text-foreground-muted">{note}</Text> : null}

        <View className="gap-2">
          <Button
            label="Compact context"
            tone="secondary"
            fullWidth
            disabled={compactDisabled}
            accessibilityHint="Asks the agent to summarize the conversation so far"
            onPress={() => {
              props.onClose();
              props.onCompact();
            }}
          />
          {compactDisabled ? (
            <Text className="text-sm text-foreground-muted">{props.compactDisabledReason}</Text>
          ) : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}
