// Expectations for the SYNTHETIC Antigravity ACP transcripts here (see each file's metadata).
// They use the raw shapes checked-in tests rely on and do not prove what an installed AGY emits.

/** `tool_call` plus `tool_call_update` frames in completeness.ndjson. */
export const COMPLETENESS_NATIVE_TOOL_FRAME_COUNT = 24;

/** Distinct native tool IDs in first-appearance order. */
export const COMPLETENESS_NATIVE_TOOL_IDS: ReadonlyArray<string> = [
  "view-1",
  "grep-1",
  "edit-1",
  "par-a",
  "par-b",
  "cmd-1",
  "perm-1",
  "err-1",
  "trajectory:4",
  "mcp-1",
];

/**
 * `turnItemType:nativeId` for every T3 turn item the completeness replay emits, in
 * first-appearance order. Message, reasoning and plan IDs carry the synthetic turn prefix.
 */
export const COMPLETENESS_EXPECTED_TURN_ITEMS: ReadonlyArray<string> = [
  "assistant_message:agy-session-01:turn:1:assistant:message:agy-msg-1",
  "reasoning:agy-session-01:turn:1:reasoning:message:agy-thought-1",
  "dynamic_tool:view-1",
  "file_search:grep-1",
  "assistant_message:agy-session-01:turn:1:assistant:message:agy-msg-2",
  "file_change:edit-1",
  "dynamic_tool:par-a",
  "file_search:par-b",
  "todo_list:agy-session-01:turn:1:plan:legacy",
  "command_execution:cmd-1",
  "command_execution:perm-1",
  "approval_request:perm-1",
  "command_execution:err-1",
  "user_message:trajectory:4:prompt",
  "subagent:trajectory:4",
  "dynamic_tool:mcp-1",
  "reasoning:agy-session-01:turn:1:reasoning:message:agy-thought-2",
  "assistant_message:agy-session-01:turn:1:assistant:message:agy-msg-3",
];

/** Every session/update kind in progress_only.ndjson, in order. */
export const PROGRESS_ONLY_NATIVE_UPDATE_KINDS: ReadonlyArray<string> = [
  "tool_call",
  "tool_call_update",
  "tool_call_update",
  "tool_call_update",
  "tool_call_update",
  "tool_call_update",
  "tool_call_update",
];
