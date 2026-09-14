import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadForkError,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const envId = EnvironmentId.make("env-local");
const projId = ProjectId.make("proj-1");
const sourceThreadId = ThreadId.make("thread-src-1");

const testState = vi.hoisted(() => ({
  thread: null as EnvironmentThreadShell | null,
  serverConfigs: new Map<string, ServerConfig>(),
  settings: { providers: {} },
  forkMutation: vi.fn(),
  navigate: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => testState.thread,
  useServerConfigs: () => testState.serverConfigs,
}));

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: () => testState.settings,
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.forkMutation,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: testState.navigate,
  }),
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: unknown) => testState.toastAdd(toast) },
  stackedThreadToast: (options: unknown) => options,
}));

vi.mock("../ui/dialog", () => {
  const Container = ({
    children,
    open,
  }: {
    readonly children?: ReactNode;
    readonly open?: boolean;
  }) => (open === false ? null : <div data-slot="dialog-container">{children}</div>);
  return {
    Dialog: Container,
    DialogDescription: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-description">{children}</div>
    ),
    DialogFooter: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-footer">{children}</div>
    ),
    DialogHeader: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-header">{children}</div>
    ),
    DialogPanel: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-panel">{children}</div>
    ),
    DialogPopup: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-popup">{children}</div>
    ),
    DialogTitle: ({ children }: { readonly children?: ReactNode }) => (
      <div data-slot="dialog-title">{children}</div>
    ),
  };
});

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/input", () => ({
  Input: (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("../ui/alert", () => ({
  Alert: ({
    children,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly [key: string]: unknown;
  }) => (
    <div role="alert" {...props}>
      {children}
    </div>
  ),
  AlertDescription: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../ui/badge", () => ({
  Badge: ({
    children,
    className,
  }: {
    readonly children?: ReactNode;
    readonly className?: string;
  }) => (
    <span data-slot="badge" className={className}>
      {children}
    </span>
  ),
}));

import { ForkThreadDialog } from "./ForkThreadDialog";

function makeProvider(input: {
  instanceId: string;
  driver: string;
  enabled?: boolean;
  installed?: boolean;
  status?: "ready" | "error" | "warning";
  models?: Array<{ slug: string; name: string }>;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: input.installed ?? true,
    version: "1.0.0",
    status: input.status ?? "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-01T00:00:00.000Z",
    models: (input.models ?? []).map((m) => ({
      slug: m.slug,
      name: m.name,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

const codexProvider = makeProvider({
  instanceId: "codex",
  driver: "codex",
  models: [
    { slug: "gpt-4o", name: "GPT-4o" },
    { slug: "o1", name: "o1" },
  ],
});

const claudeProvider = makeProvider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  models: [{ slug: "claude-3-7-sonnet", name: "Claude 3.7 Sonnet" }],
});

const defaultThread = {
  id: sourceThreadId,
  projectId: projId,
  title: "Optimize database queries",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-4o",
  },
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  archivedAt: null,
  settledAt: null,
  snoozedUntil: null,
  pinnedAt: null,
  branch: null,
  worktreePath: null,
  session: null,
  latestTurn: null,
} as unknown as EnvironmentThreadShell;

let renderer: ReactTestRenderer | null = null;

describe("ForkThreadDialog", () => {
  beforeEach(() => {
    renderer = null;
    testState.thread = defaultThread;
    testState.serverConfigs = new Map([
      [
        envId,
        {
          environmentId: envId,
          label: "Local",
          providers: [codexProvider, claudeProvider],
          capabilities: { threadForking: true },
        } as unknown as ServerConfig,
      ],
    ]);
    testState.forkMutation.mockReset();
    testState.navigate.mockReset().mockResolvedValue(undefined);
    testState.toastAdd.mockReset();
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
      renderer = null;
    }
  });

  it("renders the dialog with default fork title and preselects the alternate model", async () => {
    await act(async () => {
      renderer = create(
        <ForkThreadDialog
          open={true}
          threadRef={{ environmentId: envId, threadId: sourceThreadId }}
          onOpenChange={vi.fn()}
        />,
      );
    });

    const root = renderer!.root;

    // Check title input has default "(fork)" appended
    const input = root.findByType("input");
    expect(input.props.value).toBe("Optimize database queries (fork)");

    // Check model options list
    const options = root.findAll((node) => node.props?.role === "option");
    expect(options).toHaveLength(3);

    // Default selection should be the alternate model (codex:o1 or claude-3-7-sonnet)
    const selectedOptions = options.filter((node) => node.props["aria-selected"] === true);
    expect(selectedOptions).toHaveLength(1);
    expect(selectedOptions[0]!.props["aria-selected"]).toBe(true);

    // Current model has badge
    const badge = root.findByProps({ "data-slot": "badge" });
    expect(badge.children).toContain("Current");
  });

  it("shows empty state when no provider models are available", async () => {
    testState.serverConfigs = new Map([
      [
        envId,
        {
          environmentId: envId,
          label: "Local",
          providers: [],
          capabilities: { threadForking: true },
        } as unknown as ServerConfig,
      ],
    ]);

    await act(async () => {
      renderer = create(
        <ForkThreadDialog
          open={true}
          threadRef={{ environmentId: envId, threadId: sourceThreadId }}
          onOpenChange={vi.fn()}
        />,
      );
    });

    const root = renderer!.root;
    const textNodes = root.findAllByType("p").map((p) => p.children.join(""));
    expect(textNodes).toContain("No available provider accounts or models were found.");

    // Submit button should be disabled
    const buttons = root.findAllByType("button");
    const submitButton = buttons.find((b) =>
      b.children.some((c) => typeof c === "string" && c.includes("Fork thread")),
    );
    expect(submitButton?.props.disabled).toBe(true);
  });

  it("allows switching model selection and updating title", async () => {
    await act(async () => {
      renderer = create(
        <ForkThreadDialog
          open={true}
          threadRef={{ environmentId: envId, threadId: sourceThreadId }}
          onOpenChange={vi.fn()}
        />,
      );
    });

    const root = renderer!.root;

    // Change title
    const input = root.findByType("input");
    await act(async () => {
      input.props.onChange({ target: { value: "Refactor database queries" } });
    });
    expect(root.findByType("input").props.value).toBe("Refactor database queries");

    // Select Claude model option (last one)
    const options = root.findAll((node) => node.props?.role === "option");
    const claudeOption = options[2]!;
    await act(async () => {
      claudeOption.props.onClick();
    });

    expect(claudeOption.props["aria-selected"]).toBe(true);
  });

  it("prevents duplicate clicks and disables inputs while fork mutation is in flight", async () => {
    let resolveMutation!: (res: unknown) => void;
    const pendingPromise = new Promise((resolve) => {
      resolveMutation = resolve;
    });
    testState.forkMutation.mockReturnValue(pendingPromise);

    await act(async () => {
      renderer = create(
        <ForkThreadDialog
          open={true}
          threadRef={{ environmentId: envId, threadId: sourceThreadId }}
          onOpenChange={vi.fn()}
        />,
      );
    });

    const root = renderer!.root;
    const buttons = root.findAllByType("button");
    const submitButton = buttons.find((b) =>
      b.children.some((c) => typeof c === "string" && c.includes("Fork thread")),
    )!;

    // First click triggers mutation
    await act(async () => {
      submitButton.props.onClick();
    });

    expect(testState.forkMutation).toHaveBeenCalledTimes(1);

    // During in flight: inputs and buttons disabled, "Forking…" is shown
    expect(root.findByType("input").props.disabled).toBe(true);
    const updatedButtons = root.findAllByType("button");
    const updatedSubmit = updatedButtons.find((b) =>
      b.children.some((c) => typeof c === "string" && c.includes("Forking…")),
    )!;
    expect(updatedSubmit.props.disabled).toBe(true);

    // Second click is ignored
    await act(async () => {
      updatedSubmit.props.onClick();
    });
    expect(testState.forkMutation).toHaveBeenCalledTimes(1);

    // Resolve mutation
    await act(async () => {
      resolveMutation(AsyncResult.success({ threadId: ThreadId.make("thread-child-1") }));
    });
  });

  it("displays clear error messages for source_busy, provider_unavailable, target_conflict, and transcript_too_large", async () => {
    const errorCases: Array<{ reason: string; expectedMessage: string }> = [
      {
        reason: "source_busy",
        expectedMessage:
          "The source thread is currently busy. Please wait for the current turn to complete.",
      },
      {
        reason: "provider_unavailable",
        expectedMessage: "The selected provider or model is unavailable or unauthenticated.",
      },
      {
        reason: "target_conflict",
        expectedMessage:
          "A thread with this target ID already exists or conflicts with an existing thread.",
      },
      {
        reason: "transcript_too_large",
        expectedMessage: "The conversation transcript exceeds the maximum size for forking.",
      },
    ];

    for (const { reason, expectedMessage } of errorCases) {
      testState.forkMutation.mockResolvedValueOnce(
        AsyncResult.failure(
          Cause.fail(
            new ThreadForkError({
              reason: reason as any,
              message: `Mock ${reason}`,
            }),
          ),
        ),
      );

      await act(async () => {
        renderer = create(
          <ForkThreadDialog
            open={true}
            threadRef={{ environmentId: envId, threadId: sourceThreadId }}
            onOpenChange={vi.fn()}
          />,
        );
      });

      const root = renderer!.root;
      const submitButton = root
        .findAllByType("button")
        .find((b) => b.children.some((c) => typeof c === "string" && c.includes("Fork thread")))!;

      await act(async () => {
        await submitButton.props.onClick();
      });

      // Check alert
      const alert = root.findByProps({ role: "alert" });
      expect(alert).toBeDefined();
      expect(
        alert
          .findAllByType("div")
          .some((node) => node.children.some((child) => child === expectedMessage)),
      ).toBe(true);

      // Submit button is re-enabled for retrying
      const reenabledSubmit = root
        .findAllByType("button")
        .find((b) => b.children.some((c) => typeof c === "string" && c.includes("Fork thread")))!;
      expect(reenabledSubmit.props.disabled).toBe(false);

      await act(async () => {
        renderer?.unmount();
      });
      renderer = null;
    }
  });

  it("handles successful fork by triggering toast, callback, closing dialog, and routing to new thread", async () => {
    const targetThreadId = ThreadId.make("thread-child-456");
    testState.forkMutation.mockResolvedValueOnce(AsyncResult.success({ threadId: targetThreadId }));

    const onOpenChange = vi.fn();
    const onForkSuccess = vi.fn();

    await act(async () => {
      renderer = create(
        <ForkThreadDialog
          open={true}
          threadRef={{ environmentId: envId, threadId: sourceThreadId }}
          onOpenChange={onOpenChange}
          onForkSuccess={onForkSuccess}
        />,
      );
    });

    const root = renderer!.root;
    const submitButton = root
      .findAllByType("button")
      .find((b) => b.children.some((c) => typeof c === "string" && c.includes("Fork thread")))!;

    await act(async () => {
      await submitButton.props.onClick();
    });

    // Verified mutation was called with correct payload
    expect(testState.forkMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: envId,
        input: expect.objectContaining({
          projectId: projId,
          sourceThreadId: sourceThreadId,
          title: "Optimize database queries (fork)",
        }),
      }),
    );

    // Dialog closed
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // Toast added
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "success",
        title: "Thread forked",
      }),
    );

    // Success callback called
    expect(onForkSuccess).toHaveBeenCalledWith(targetThreadId);

    // Navigated to new thread route
    expect(testState.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: envId,
          threadId: targetThreadId,
        },
      }),
    );
  });
});
