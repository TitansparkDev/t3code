import { describe, expect, it } from "vite-plus/test";

import { markdownPlainText } from "./markdownPlainText.ts";

describe("markdownPlainText", () => {
  it("keeps readable paragraphs, lists, links, code, and image alt text", () => {
    expect(
      markdownPlainText(
        "**Fixed.**\n\n- Tests pass\n- [Review](https://example.com)\n\n`ready`\n\n![diagram](diagram.png)",
      ),
    ).toBe("Fixed.\n\n• Tests pass\n• Review\n\nready\n\ndiagram");
  });

  it("drops raw HTML and preserves Unicode without exposing markup", () => {
    expect(markdownPlainText("<script>secret()</script>\n\n🤖 **done**")).toBe("🤖 done");
  });
});
