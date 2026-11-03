// Expectations for the synthetic Antigravity ACP fixtures in this directory.
// Both transcripts are SYNTHETIC (see each file's metadata.authenticity): they use the
// raw shapes checked-in tests already rely on, and they do not prove what an installed
// Antigravity build emits. Native counts below are read from the transcripts; they are
// the reference the T3 layers are compared against, not a claim about upstream.

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
