import { describe, expect, it } from "vite-plus/test";

import {
  canToggleMarkdownPreview,
  defaultFileViewMode,
  resolveFileViewMode,
} from "./file-view-mode";

describe("file view mode", () => {
  it("lets the persisted Markdown preference choose the default", () => {
    expect(
      resolveFileViewMode({
        path: "README.md",
        targetLine: null,
        modeOverride: null,
        markdownPreviewEnabled: true,
      }),
    ).toBe("preview");
    expect(defaultFileViewMode("README.md")).toBe("source");
  });

  it("always keeps targeted files in source mode", () => {
    expect(
      resolveFileViewMode({
        path: "README.md",
        targetLine: 12,
        modeOverride: { path: "README.md", mode: "preview" },
        markdownPreviewEnabled: true,
      }),
    ).toBe("source");
    expect(canToggleMarkdownPreview("README.md", 12)).toBe(false);
  });

  it("does not offer Markdown controls for unsupported paths", () => {
    expect(canToggleMarkdownPreview("archive.zip", null)).toBe(false);
    expect(canToggleMarkdownPreview(null, null)).toBe(false);
    expect(
      resolveFileViewMode({
        path: "archive.zip",
        targetLine: null,
        modeOverride: null,
        markdownPreviewEnabled: true,
      }),
    ).toBe("source");
  });

  it("keeps non-Markdown media previews on their existing defaults", () => {
    expect(defaultFileViewMode("index.html")).toBe("preview");
    expect(defaultFileViewMode("screenshot.png")).toBe("preview");
    expect(defaultFileViewMode("notes.txt")).toBe("source");
  });

  it("preserves a per-file source override over the persisted default", () => {
    expect(
      resolveFileViewMode({
        path: "README.md",
        targetLine: null,
        modeOverride: { path: "README.md", mode: "source" },
        markdownPreviewEnabled: true,
      }),
    ).toBe("source");
  });
});
