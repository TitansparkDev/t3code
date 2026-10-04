import { createFileRoute } from "@tanstack/react-router";

import { UsageLimitAutoResumeSettingsPanel } from "../components/settings/UsageLimitAutoResumeSettings";

function SettingsAutoResumeRoute() {
  return <UsageLimitAutoResumeSettingsPanel />;
}

export const Route = createFileRoute("/settings/auto-resume")({
  component: SettingsAutoResumeRoute,
});
