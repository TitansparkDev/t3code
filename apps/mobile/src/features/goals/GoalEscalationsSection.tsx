import {
  describeEscalationKind,
  describeEscalationStatus,
  isEscalationOpen,
  sortEscalationsNewestFirst,
} from "@t3tools/client-runtime/goal-progress";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Goal, GoalEscalation, GoalEscalationResolveAction } from "@t3tools/contracts/goals";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const REASON_CLAMP_THRESHOLD = 160;

function EscalationNoteInput(props: {
  readonly placeholder: string;
  readonly submitLabel: string;
  readonly onSubmit: (note: string) => Promise<boolean>;
  readonly onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={props.placeholder}
        className="min-h-20 rounded-[16px] px-4 py-3 text-base leading-snug"
        editable={!busy}
        multiline
        onChangeText={setNote}
        placeholder={props.placeholder}
        value={note}
      />
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={props.submitLabel}
          loading={busy}
          onPress={() => {
            setBusy(true);
            void props.onSubmit(note.trim()).then((sent) => {
              setBusy(false);
              if (sent) props.onDone();
            });
          }}
        />
        <Button label="Close" onPress={props.onDone} tone="text" />
      </View>
    </View>
  );
}

function EscalationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly escalation: GoalEscalation;
  readonly onChanged: () => void;
}) {
  const { escalation, environmentId } = props;
  const resolveEscalation = useAtomCommand(serverEnvironment.resolveGoalEscalation);
  const cancelEscalation = useAtomCommand(serverEnvironment.cancelGoalEscalation);
  const [expanded, setExpanded] = useState(false);
  const [pendingAction, setPendingAction] = useState<GoalEscalationResolveAction | null>(null);
  const open = isEscalationOpen(escalation);
  const long = escalation.reason.length > REASON_CLAMP_THRESHOLD;

  const failed = (message: string) => {
    Alert.alert(message, "Check the connection and try again.");
  };

  return (
    <View
      className={cn(
        "gap-2 rounded-[18px] p-3",
        escalation.status === "needs-person" ? "border border-warning bg-card" : "bg-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">
        {describeEscalationKind(escalation)} · {describeEscalationStatus(escalation)}
      </Text>
      <Text className="text-sm text-foreground-muted" numberOfLines={expanded ? undefined : 3}>
        {escalation.reason}
      </Text>
      {long ? (
        <Button
          label={expanded ? "Show less" : "Show more"}
          onPress={() => setExpanded(!expanded)}
          tone="text"
        />
      ) : null}
      {escalation.resolution ? (
        <Text className="text-sm text-foreground-muted">
          {escalation.resolution.by === "person" ? "You" : "Overseer"}:{" "}
          {escalation.resolution.note || escalation.resolution.action}
        </Text>
      ) : null}
      {open && pendingAction ? (
        <EscalationNoteInput
          onDone={() => setPendingAction(null)}
          onSubmit={async (note) => {
            const result = await resolveEscalation({
              environmentId,
              input: { id: escalation.id, action: pendingAction, note },
            });
            props.onChanged();
            if (AsyncResult.isFailure(result)) {
              failed("Could not answer the overseer");
              return false;
            }
            return true;
          }}
          placeholder={
            pendingAction === "retry"
              ? "A short note for the worker, e.g. what to change"
              : "Why the task should be given up"
          }
          submitLabel={pendingAction === "retry" ? "Tell worker to retry" : "Give up task"}
        />
      ) : open ? (
        <View className="flex-row flex-wrap gap-2">
          <Button label="Tell worker to retry" onPress={() => setPendingAction("retry")} />
          <Button label="Give up task" onPress={() => setPendingAction("give-up")} />
          <Button
            label="Cancel"
            onPress={() =>
              void (async () => {
                const result = await cancelEscalation({
                  environmentId,
                  input: { id: escalation.id },
                });
                props.onChanged();
                if (AsyncResult.isFailure(result)) failed("Could not cancel the escalation");
              })()
            }
            tone="text"
          />
        </View>
      ) : null}
    </View>
  );
}

/** The goal's problems for the overseer, newest first, and a way to ask about the whole goal. */
export function GoalEscalationsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly goal: Goal;
  readonly onChanged: () => void;
}) {
  const { environmentId, goal } = props;
  const askOverseer = useAtomCommand(serverEnvironment.openGoalEscalation);
  const [asking, setAsking] = useState(false);
  const escalations = sortEscalationsNewestFirst(goal.escalations ?? []);

  return (
    <View className="gap-2 border-t border-border pt-3">
      <View className="flex-row items-center justify-between">
        <Text className="text-sm font-t3-medium text-foreground">Overseer</Text>
        {asking ? null : (
          <Button label="Ask overseer" onPress={() => setAsking(true)} tone="text" />
        )}
      </View>
      {asking ? (
        <EscalationNoteInput
          onDone={() => setAsking(false)}
          onSubmit={async (note) => {
            const result = await askOverseer({
              environmentId,
              input: { goalId: goal.id, note },
            });
            props.onChanged();
            if (AsyncResult.isFailure(result)) {
              Alert.alert("Could not ask the overseer", "Check the connection and try again.");
              return false;
            }
            return true;
          }}
          placeholder="What should the overseer look at?"
          submitLabel="Ask"
        />
      ) : null}
      {escalations.length === 0 ? (
        <Text className="text-sm text-foreground-muted">No problems raised.</Text>
      ) : (
        escalations.map((escalation) => (
          <EscalationRow
            environmentId={environmentId}
            escalation={escalation}
            key={escalation.id}
            onChanged={props.onChanged}
          />
        ))
      )}
    </View>
  );
}
