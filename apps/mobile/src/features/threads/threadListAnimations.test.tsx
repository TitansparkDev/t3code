import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import {
  THREAD_SIDEBAR_ROW_LAYOUT,
  useThreadListShelfLayoutAnimation,
} from "./threadListAnimations";

vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition, reduceMotion: () => transition };
  return { LinearTransition: transition, ReduceMotion: { System: "system" } };
});

it("skips the row layout transition only on the commit that changes the shelf expansion", async () => {
  const seen: Array<unknown> = [];
  function Probe(props: { readonly shelfKey: string }) {
    const animation = useThreadListShelfLayoutAnimation(props.shelfKey);
    useLayoutEffect(() => {
      seen.push(animation);
    });
    return null;
  }

  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Probe shelfKey="false:false:false" />));
  expect(seen).toEqual([THREAD_SIDEBAR_ROW_LAYOUT]);

  await act(async () => root.render(<Probe shelfKey="true:false:false" />));
  expect(seen.slice(1)).toEqual([undefined, THREAD_SIDEBAR_ROW_LAYOUT]);

  await act(async () => root.render(<Probe shelfKey="true:false:false" />));
  expect(seen.at(-1)).toBe(THREAD_SIDEBAR_ROW_LAYOUT);
  await act(async () => root.unmount());
});
