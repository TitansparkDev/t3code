/**
 * Usage-limit auto-resume settings — which provider accounts and models pick
 * their work back up on their own when a usage limit resets.
 *
 * The server does the resuming, so a ticked model resumes with every client
 * closed. Each environment keeps its own list because provider accounts are
 * per environment.
 *
 * @module UsageLimitAutoResumeSettings
 */
import type {
  EnvironmentId,
  ProviderInstanceId,
  UsageLimitAutoResumeRule,
} from "@t3tools/contracts";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import {
  autoResumeStateFor,
  setInstanceAutoResume,
  setModelAutoResume,
} from "./usageLimitAutoResume.logic";

export function UsageLimitAutoResumeSettingsPanel() {
  const { environments } = useEnvironments();
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update usage-limit auto-resume",
  });

  const save = (environmentId: EnvironmentId, rules: ReadonlyArray<UsageLimitAutoResumeRule>) =>
    update({ environmentId, input: { patch: { usageLimitAutoResume: rules } } });

  return (
    <SettingsPageContainer>
      <SettingsSection title="Auto-resume after a usage limit">
        <p className="px-1 text-xs text-muted-foreground">
          When a thread stops on a usage limit and its provider and model are switched on here, the
          server resumes it as soon as the limit resets. You do not need to be online. Models that
          are off keep the usual prompt in the thread.
        </p>
        {environments.map((environment) => {
          const rules = environment.serverConfig?.settings.usageLimitAutoResume ?? [];
          const instances = deriveProviderInstanceEntries(
            environment.serverConfig?.providers ?? [],
          ).filter((instance) => instance.enabled && instance.installed);
          return (
            <div
              className="space-y-3 rounded-lg border border-border/60 p-3"
              key={environment.environmentId}
            >
              <h4 className="text-sm font-medium">{environment.label}</h4>
              {environment.connection.phase !== "connected" || !environment.serverConfig ? (
                <p className="text-xs text-muted-foreground">Connect this environment to edit.</p>
              ) : instances.length === 0 ? (
                <p className="text-xs text-muted-foreground">No provider accounts are enabled.</p>
              ) : (
                instances.map((instance) => {
                  const state = autoResumeStateFor(rules, instance.instanceId);
                  return (
                    <div className="space-y-1.5" key={instance.instanceId}>
                      <label className="flex items-center justify-between gap-3 text-sm font-medium">
                        {instance.displayName}
                        <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
                          All models
                          <Switch
                            checked={state === "all"}
                            onCheckedChange={(enabled) =>
                              void save(
                                environment.environmentId,
                                setInstanceAutoResume(rules, instance.instanceId, enabled),
                              )
                            }
                          />
                        </span>
                      </label>
                      <ModelSwitches
                        disabled={state === "all"}
                        instanceId={instance.instanceId}
                        models={instance.models}
                        onChange={(model, enabled) =>
                          void save(
                            environment.environmentId,
                            setModelAutoResume(rules, instance.instanceId, model, enabled),
                          )
                        }
                        rules={rules}
                      />
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function ModelSwitches({
  disabled,
  instanceId,
  models,
  onChange,
  rules,
}: {
  readonly disabled: boolean;
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly onChange: (model: string, enabled: boolean) => void;
  readonly rules: ReadonlyArray<UsageLimitAutoResumeRule>;
}) {
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {models.map((model) => (
        <label
          className="flex items-center justify-between gap-3 rounded-md px-2 py-1 text-xs text-muted-foreground"
          key={model.slug}
        >
          <span className="truncate">{model.name}</span>
          <Switch
            checked={
              disabled ||
              rules.some((rule) => rule.instanceId === instanceId && rule.model === model.slug)
            }
            disabled={disabled}
            onCheckedChange={(enabled) => onChange(model.slug, enabled)}
          />
        </label>
      ))}
    </div>
  );
}
