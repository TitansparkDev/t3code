import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("./UsageLimitBanner", () => ({
  UsageLimitBanner: (props: { readonly visible: boolean }) => (
    <span data-testid="usage-strip" data-visible={String(props.visible)} />
  ),
}));

import { UsageBannerSlot, UsageBannerSlotProvider } from "./UsageBannerSlot";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Route(props: { readonly visible: boolean; readonly headerIds: readonly string[] }) {
  return (
    <UsageBannerSlotProvider visible={props.visible}>
      {props.headerIds.map((id) => (
        <UsageBannerSlot key={id} />
      ))}
    </UsageBannerSlotProvider>
  );
}

async function mountRoute(visible: boolean, headerIds: readonly string[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (next: { visible: boolean; headerIds: readonly string[] }) =>
    act(async () => root.render(<Route {...next} />));
  await render({ visible, headerIds });
  const strips = () => [...container.querySelectorAll<HTMLElement>('[data-testid="usage-strip"]')];
  return {
    strips,
    rerender: render,
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("shows exactly one strip when a route mounts several headers", async () => {
  const route = await mountRoute(true, ["header-a", "header-b", "header-c"]);
  try {
    expect(route.strips()).toHaveLength(1);
  } finally {
    await route.unmount();
  }
});

it("moves the strip to the next mounted header when the owning header unmounts", async () => {
  const route = await mountRoute(true, ["header-a", "header-b"]);
  try {
    await route.rerender({ visible: true, headerIds: ["header-b"] });
    expect(route.strips()).toHaveLength(1);
    expect(route.strips()[0]?.dataset.visible).toBe("true");
  } finally {
    await route.unmount();
  }
});

it("passes workspace visibility to the single strip so a hidden route keeps it hidden", async () => {
  const route = await mountRoute(false, ["header-a", "header-b"]);
  try {
    expect(route.strips()).toHaveLength(1);
    expect(route.strips()[0]?.dataset.visible).toBe("false");
  } finally {
    await route.unmount();
  }
});
