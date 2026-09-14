import { EventId, TurnId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveLatestContextWindowSnapshot } from "~/lib/contextWindow";
import { ContextWindowMeter } from "./ContextWindowMeter";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ closeDelay, render }: { closeDelay: number; render: ReactNode }) => (
    <div data-close-delay={closeDelay}>{render}</div>
  ),
}));

const usage = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-1"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usage) {
  throw new Error("The context window test fixture did not produce a snapshot.");
}

const usageWithTotalProcessed = deriveLatestContextWindowSnapshot([
  {
    id: EventId.make("activity-with-total"),
    tone: "info",
    kind: "context-window.updated",
    summary: "Context updated",
    payload: { usedTokens: 100_000, totalProcessedTokens: 748_126, maxTokens: 1_000_000 },
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-08-24T12:00:00.000Z",
  },
]);

if (!usageWithTotalProcessed) {
  throw new Error("The processed-token context window test fixture did not produce a snapshot.");
}

function usageWithProcessedTotal(value: unknown) {
  const snapshot = deriveLatestContextWindowSnapshot([
    {
      id: EventId.make("activity-invalid-total"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context updated",
      payload: { usedTokens: 100_000, totalProcessedTokens: value, maxTokens: 1_000_000 },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  ]);

  if (!snapshot) {
    throw new Error("The processed-token context window test fixture did not produce a snapshot.");
  }

  return snapshot;
}

describe("ContextWindowMeter", () => {
  it("shows positive processed totals in the usage details", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usageWithTotalProcessed} />);

    expect(markup).toContain("Total processed");
    expect(markup).toContain("748k");
  });

  it("hides a missing processed total", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).not.toContain("Total processed");
  });

  it.each([null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "hides an unusable processed total (%s)",
    (totalProcessedTokens) => {
      const markup = renderToStaticMarkup(
        <ContextWindowMeter usage={usageWithProcessedTotal(totalProcessedTokens)} />,
      );

      expect(markup).not.toContain("Total processed");
    },
  );

  it("keeps the hover popover open while the pointer moves to the compact button", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} onCompact={() => {}} />);

    expect(markup).toContain('data-close-delay="150"');
    expect(markup).toContain("Compact context");
  });

  it("closes an informational hover popover without delay", () => {
    const markup = renderToStaticMarkup(<ContextWindowMeter usage={usage} />);

    expect(markup).toContain('data-close-delay="0"');
    expect(markup).not.toContain("Compact context");
  });

  it("explains why the compact action is disabled", () => {
    const markup = renderToStaticMarkup(
      <ContextWindowMeter
        usage={usage}
        onCompact={() => {}}
        compactDisabled
        compactDisabledReason="Send or clear your draft before compacting"
      />,
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain(">Send or clear your draft before compacting<");
    expect(markup).not.toContain('aria-label="Send or clear your draft before compacting"');
  });
});
