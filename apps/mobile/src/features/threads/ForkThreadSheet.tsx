import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type ModelSelection, type ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import { buildModelOptions, type ModelOption } from "../../lib/modelOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { uuidv4 } from "../../lib/uuid";
import { environmentServerConfigsAtom } from "../../state/server";
import { closeForkThread, forkThreadCommand, forkThreadTargetAtom } from "../../state/thread-fork";
import { useAtomCommand } from "../../state/use-atom-command";
import { defaultForkTitle, formatForkErrorMessage, resolveDefaultForkOption } from "./thread-fork";

export function ForkThreadSheet(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onClose: () => void;
  readonly onForkSuccess: (targetThreadId: string) => void;
}) {
  const { thread, onClose, onForkSuccess } = props;
  const insets = useSafeAreaInsets();
  const theme = useUniwindTheme();
  const mutedTextColor = String(theme["--color-foreground-muted"] ?? "#8e8e93");
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const serverConfig = serverConfigs.get(thread.environmentId);
  const forkThreadMutation = useAtomCommand(forkThreadCommand, { reportFailure: false });

  const modelOptions = useMemo(
    () =>
      buildModelOptions(serverConfig, thread.modelSelection).filter(
        (opt) =>
          !opt.isUnavailable &&
          serverConfig?.providers.some(
            (provider) =>
              provider.instanceId === opt.providerKey &&
              provider.enabled &&
              provider.installed &&
              provider.auth.status === "authenticated" &&
              provider.status === "ready" &&
              provider.availability !== "unavailable",
          ) === true,
      ),
    [serverConfig, thread.modelSelection],
  );

  const [selectedOption, setSelectedOption] = useState<ModelOption | null>(() =>
    resolveDefaultForkOption(modelOptions, thread.modelSelection),
  );
  const [title, setTitle] = useState(() => defaultForkTitle(thread.title));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedOption(resolveDefaultForkOption(modelOptions, thread.modelSelection));
    setTitle(defaultForkTitle(thread.title));
    setIsSubmitting(false);
    setError(null);
  }, [modelOptions, thread.modelSelection, thread.title]);

  const handleFork = useCallback(async () => {
    if (isSubmitting || !selectedOption || !title.trim()) return;
    setIsSubmitting(true);
    setError(null);

    const targetThreadId = ThreadId.make(uuidv4());
    const modelSelection: ModelSelection = {
      instanceId: selectedOption.providerKey as ProviderInstanceId,
      model: selectedOption.selection.model,
      ...(selectedOption.selection.options ? { options: selectedOption.selection.options } : {}),
    };

    const trimmedTitle = title.trim();
    const result = await forkThreadMutation({
      environmentId: thread.environmentId,
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
    const destinationThreadId = result.value.threadId ?? targetThreadId;
    onForkSuccess(destinationThreadId);
  }, [
    forkThreadMutation,
    isSubmitting,
    onForkSuccess,
    selectedOption,
    thread.environmentId,
    thread.id,
    thread.projectId,
    title,
  ]);

  const isCurrentModel = (option: ModelOption) =>
    thread.modelSelection != null &&
    option.selection.instanceId === thread.modelSelection.instanceId &&
    option.selection.model === thread.modelSelection.model;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={isSubmitting ? undefined : onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-end bg-backdrop"
      >
        <Pressable
          className="flex-1"
          onPress={isSubmitting ? undefined : onClose}
          accessibilityLabel="Dismiss fork thread sheet"
          accessibilityRole="button"
        />
        <View
          className="w-full max-w-xl self-center rounded-t-[28px] bg-sheet-solid px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          {/* Grabber */}
          <View className="mb-3 h-1 w-10 self-center rounded-full bg-border" />

          {/* Header */}
          <View className="mb-4">
            <View className="flex-row items-center gap-2">
              <SymbolView
                name="arrow.triangle.branch"
                size={18}
                tintColorClassName="accent-primary"
                type="monochrome"
                weight="semibold"
              />
              <Text className="text-lg font-t3-bold text-foreground">Fork thread</Text>
            </View>
            <Text className="mt-1 text-xs leading-4 text-foreground-secondary">
              {thread.title
                ? `Fork “${thread.title}” to continue with a different model or provider.`
                : "Fork this thread to continue with a different model or provider."}{" "}
              The original thread will remain untouched.
            </Text>
          </View>

          {/* Error Message */}
          {error ? (
            <View className="mb-3 rounded-xl bg-danger-subtle p-3 border border-danger/30">
              <Text className="text-xs text-danger-foreground font-t3-medium">{error}</Text>
            </View>
          ) : null}

          {/* Title Input */}
          <View className="mb-3.5">
            <Text className="mb-1 text-xs font-t3-bold text-foreground-muted">Thread title</Text>
            <TextInput
              accessibilityLabel="Thread title"
              className="h-11 rounded-xl bg-card px-3.5 text-base font-t3-medium text-foreground border border-border-subtle"
              editable={!isSubmitting}
              onChangeText={setTitle}
              placeholder="Thread title"
              placeholderTextColor={mutedTextColor}
              value={title}
              autoCapitalize="sentences"
              autoCorrect
            />
          </View>

          {/* Target Provider & Model Selection */}
          <View className="mb-4">
            <Text className="mb-1 text-xs font-t3-bold text-foreground-muted">
              Target provider & model
            </Text>
            {modelOptions.length === 0 ? (
              <View className="rounded-xl border border-border-subtle bg-card p-4 items-center">
                <Text className="text-xs text-foreground-muted">
                  No available provider accounts or models were found.
                </Text>
              </View>
            ) : (
              <ScrollView
                className="max-h-56 rounded-xl border border-border-subtle bg-card"
                nestedScrollEnabled
                contentContainerStyle={{ padding: 6, gap: 4 }}
              >
                {modelOptions.map((option) => {
                  const isSelected =
                    selectedOption?.selection.instanceId === option.selection.instanceId &&
                    selectedOption?.selection.model === option.selection.model;
                  const current = isCurrentModel(option);

                  return (
                    <Pressable
                      key={option.key}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`${option.label}, ${option.providerLabel}`}
                      disabled={isSubmitting}
                      onPress={() => setSelectedOption(option)}
                      className={cn(
                        "flex-row items-center justify-between rounded-lg px-3 py-2.5 active:bg-subtle",
                        isSelected && "bg-subtle-strong border border-primary/40",
                      )}
                    >
                      <View className="flex-1 flex-row items-center gap-2.5 mr-2">
                        <ProviderIcon provider={option.providerDriver} size={16} />
                        <View className="flex-1">
                          <View className="flex-row items-center gap-1.5">
                            <Text
                              className="text-sm font-t3-medium text-foreground"
                              numberOfLines={1}
                            >
                              {option.label}
                            </Text>
                            {current ? (
                              <View className="rounded-md bg-subtle px-1.5 py-0.5">
                                <Text className="text-3xs font-t3-bold text-foreground-muted">
                                  Current
                                </Text>
                              </View>
                            ) : null}
                          </View>
                          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                            {option.providerLabel}
                          </Text>
                        </View>
                      </View>
                      {isSelected ? (
                        <SymbolView
                          name="checkmark"
                          size={14}
                          tintColorClassName="accent-icon"
                          type="monochrome"
                          weight="semibold"
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
          </View>

          {/* Action Buttons */}
          <View className="flex-row items-center gap-2.5 pt-1">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              className="flex-1 min-h-11 items-center justify-center rounded-xl bg-card active:bg-subtle border border-border-subtle"
              disabled={isSubmitting}
              onPress={onClose}
            >
              <Text className="text-sm font-t3-semibold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Fork thread"
              className={cn(
                "flex-1 min-h-11 flex-row items-center justify-center gap-1.5 rounded-xl bg-primary active:opacity-80",
                (isSubmitting || !selectedOption || !title.trim()) && "opacity-50",
              )}
              disabled={isSubmitting || !selectedOption || !title.trim()}
              onPress={handleFork}
            >
              {isSubmitting ? (
                <>
                  <ActivityIndicator size="small" color="#ffffff" />
                  <Text className="text-sm font-t3-bold text-primary-foreground">Forking…</Text>
                </>
              ) : (
                <>
                  <SymbolView
                    name="arrow.triangle.branch"
                    size={14}
                    tintColorClassName="accent-primary-foreground"
                    type="monochrome"
                    weight="bold"
                  />
                  <Text className="text-sm font-t3-bold text-primary-foreground">Fork thread</Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ForkThreadHost() {
  const target = useAtomValue(forkThreadTargetAtom);
  const navigation = useNavigation<NativeStackNavigationProp<ReactNavigation.RootParamList>>();

  if (target === null) return null;

  return (
    <ForkThreadSheet
      thread={target}
      onClose={closeForkThread}
      onForkSuccess={(targetThreadId) => {
        closeForkThread();
        navigation.navigate("Thread", {
          environmentId: String(target.environmentId),
          threadId: String(targetThreadId),
        });
      }}
    />
  );
}
