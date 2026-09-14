import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
} from "@t3tools/shared/filePreview";

import { isMarkdownPreviewFile, isVideoPreviewFile } from "./filePath";

export type FileViewMode = "preview" | "source";

export interface FileViewModeOverride {
  readonly path: string;
  readonly mode: FileViewMode;
}

export function defaultFileViewMode(path: string | null): FileViewMode {
  return path !== null &&
    (isWorkspaceBrowserPreviewPath(path) ||
      isWorkspaceImagePreviewPath(path) ||
      isVideoPreviewFile(path))
    ? "preview"
    : "source";
}

export function resolveFileViewMode(input: {
  readonly path: string | null;
  readonly targetLine: number | null;
  readonly modeOverride: FileViewModeOverride | null;
  readonly markdownPreviewEnabled: boolean;
}): FileViewMode {
  if (input.path === null || input.targetLine !== null) {
    return "source";
  }
  if (input.modeOverride?.path === input.path) {
    return input.modeOverride.mode;
  }
  if (isMarkdownPreviewFile(input.path) && input.markdownPreviewEnabled) {
    return "preview";
  }
  return defaultFileViewMode(input.path);
}

export function canToggleMarkdownPreview(path: string | null, targetLine: number | null): boolean {
  return path !== null && targetLine === null && isMarkdownPreviewFile(path);
}
