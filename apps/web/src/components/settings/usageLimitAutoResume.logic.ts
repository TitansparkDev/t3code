import {
  USAGE_LIMIT_AUTO_RESUME_ANY_MODEL,
  type ProviderInstanceId,
  type UsageLimitAutoResumeRule,
} from "@t3tools/contracts";

export type AutoResumeState = "all" | "some" | "none";

export function autoResumeStateFor(
  rules: ReadonlyArray<UsageLimitAutoResumeRule>,
  instanceId: ProviderInstanceId,
): AutoResumeState {
  const own = rules.filter((rule) => rule.instanceId === instanceId);
  if (own.some((rule) => rule.model === USAGE_LIMIT_AUTO_RESUME_ANY_MODEL)) return "all";
  return own.length > 0 ? "some" : "none";
}

/** Turn one model on or off. A model switch never touches the instance-wide rule. */
export function setModelAutoResume(
  rules: ReadonlyArray<UsageLimitAutoResumeRule>,
  instanceId: ProviderInstanceId,
  model: string,
  enabled: boolean,
): ReadonlyArray<UsageLimitAutoResumeRule> {
  const without = rules.filter((rule) => !(rule.instanceId === instanceId && rule.model === model));
  return enabled ? [...without, { instanceId, model }] : without;
}

/** "All models" replaces the per-model rules so the saved list says one thing. */
export function setInstanceAutoResume(
  rules: ReadonlyArray<UsageLimitAutoResumeRule>,
  instanceId: ProviderInstanceId,
  enabled: boolean,
): ReadonlyArray<UsageLimitAutoResumeRule> {
  const others = rules.filter((rule) => rule.instanceId !== instanceId);
  return enabled ? [...others, { instanceId, model: USAGE_LIMIT_AUTO_RESUME_ANY_MODEL }] : others;
}
