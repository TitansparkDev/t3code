import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";

interface AndroidBackgroundConnectionNative {
  configure(enabled: boolean): void;
  wake(): void;
  addListener(eventName: "onWake", listener: () => void): { remove(): void };
}

const native =
  Platform.OS === "android"
    ? requireOptionalNativeModule<AndroidBackgroundConnectionNative>("T3BackgroundConnection")
    : null;

const events = native;

export function supportsAndroidBackgroundConnection(): boolean {
  return (
    native !== null &&
    typeof native.configure === "function" &&
    typeof native.wake === "function" &&
    typeof native.addListener === "function"
  );
}

export function configureAndroidBackgroundConnection(enabled: boolean): void {
  try {
    native?.configure(enabled);
  } catch {
    // Older binaries and OEM foreground-service restrictions are optional.
  }
}

export function wakeAndroidBackgroundConnection(): void {
  try {
    native?.wake();
  } catch {
    // The JS supervisor still receives the normal AppState wakeup.
  }
}

export function subscribeAndroidBackgroundConnectionWake(listener: () => void): () => void {
  if (!events || !supportsAndroidBackgroundConnection()) return () => {};
  const subscription = events.addListener("onWake", listener);
  return () => subscription.remove();
}

export function shouldEnableAndroidBackgroundConnection(
  appState: "active" | "inactive" | "background" | "unknown",
  environmentCount: number,
): boolean {
  return Platform.OS === "android" && appState !== "active" && environmentCount > 0;
}
