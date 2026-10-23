// @effect-diagnostics globalDate:off -- UI callers need the current wall-clock instant.
const CLAUDE_PEAK_TIME_ZONE = "America/Los_Angeles";

/**
 * Anthropic's documented Claude Code peak window is weekdays from 05:00 to
 * 11:00 Pacific time. Intl handles Pacific daylight-saving changes for us.
 */
export function isClaudePeakTime(now: number | Date = Date.now()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CLAUDE_PEAK_TIME_ZONE,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const rawHour = parts.find((part) => part.type === "hour")?.value;
  const hour = rawHour === undefined ? Number.NaN : Number(rawHour === "24" ? "0" : rawHour);
  return weekday !== undefined && !["Sat", "Sun"].includes(weekday) && hour >= 5 && hour < 11;
}
