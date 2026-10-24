import { createContext, use, useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { UsageLimitBanner } from "./UsageLimitBanner";

interface UsageBannerSlotValue {
  readonly visible: boolean;
  readonly owner: string | null;
  readonly register: (id: string) => () => void;
}

const UsageBannerSlotContext = createContext<UsageBannerSlotValue | null>(null);

/**
 * Android route headers draw their own status-bar inset, so the quota strip is placed by the
 * header itself. A route can mount several headers (sheets, hidden tab panes); only the first
 * one still mounted shows the strip. Hidden `Activity` panes unregister with their effects.
 */
export function UsageBannerSlotProvider(props: {
  readonly visible: boolean;
  readonly children: ReactNode;
}) {
  const [slots, setSlots] = useState<readonly string[]>([]);
  const register = useCallback((id: string) => {
    setSlots((current) => (current.includes(id) ? current : [...current, id]));
    return () => setSlots((current) => current.filter((slot) => slot !== id));
  }, []);
  const value = useMemo(
    () => ({ visible: props.visible, owner: slots[0] ?? null, register }),
    [props.visible, register, slots],
  );
  return <UsageBannerSlotContext value={value}>{props.children}</UsageBannerSlotContext>;
}

/** Renders the route's quota strip directly below the header that mounts it. */
export function UsageBannerSlot() {
  const slot = use(UsageBannerSlotContext);
  const id = useId();
  const register = slot?.register;
  useEffect(() => register?.(id), [id, register]);
  if (!slot || slot.owner !== id) return null;
  return <UsageLimitBanner visible={slot.visible} />;
}
