import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import type { ModelSelection, ProviderInstanceId } from "@t3tools/contracts";

export const FAVORITES_PROVIDER_FILTER = "@favorites";

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

/** An explicit search finds legacy models; an empty query keeps them collapsed. */
export function visibleCatalogModels(input: {
  readonly models: ReadonlyArray<ModelOption>;
  readonly includeLegacy: boolean;
  readonly searchQuery: string;
  readonly isDisplayed: (model: ModelOption) => boolean;
  readonly isFavorite: (model: ModelOption) => boolean;
}): ReadonlyArray<ModelOption> {
  if (input.includeLegacy || input.searchQuery.trim().length > 0) {
    return input.models;
  }
  return input.models.filter(
    (model) => !model.isLegacy || input.isDisplayed(model) || input.isFavorite(model),
  );
}

export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  const query = input.query.trim().toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  return [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  if (input.current?.key === input.pressed.key) {
    return input.current;
  }
  return input.restoreSelection
    ? { ...input.pressed, selection: input.restoreSelection(input.pressed.selection) }
    : input.pressed;
}

export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
