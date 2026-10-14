// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off
/**
 * Machine toolchain the server's own check runs depend on, and the failures that mean the
 * machine, not the code, is wrong.
 *
 * A check the server runs (after a worker submits, after a merge, in an audit) has no worker
 * shell around it: it gets the server process's environment. A server started by a service
 * manager does not have the variables a person's shell exports, so a build that needs the
 * Android SDK fails with "SDK location not found" on every branch, whoever wrote it. That is
 * not a defect in any task: no worker can fix it by editing code, and sending one only burns
 * turns. This module finds the toolchain the way the repository's own checkout does, hands it
 * to the checks, and recognises the failures that remain.
 *
 * @module toolchain
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const isDirectory = (path: string | undefined): path is string => {
  if (!path) return false;
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const readProperties = (file: string): Record<string, string> => {
  try {
    const properties: Record<string, string> = {};
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([^#!\s=:][^=:]*?)\s*[=:]\s*(.*?)\s*$/.exec(line);
      if (match?.[1]) properties[match[1]] = match[2] ?? "";
    }
    return properties;
  } catch {
    return {};
  }
};

/** The checkout a repository's git directory belongs to, when it is an ordinary `.git` folder. */
export const repoRootOfGitDir = (gitCommonDir: string): string | undefined =>
  NodePath.basename(gitCommonDir) === ".git" ? NodePath.dirname(gitCommonDir) : undefined;

/**
 * Where the Android SDK is, from the same places a build looks plus the ones a person's checkout
 * has: the environment, Gradle's own `systemProp.android.home`, the checkout's ignored
 * `local.properties`, then the default install folders.
 */
export function androidSdkLocation(
  input: { readonly repoRoot?: string | undefined; readonly env?: NodeJS.ProcessEnv } = {},
): string | null {
  const env = input.env ?? process.env;
  const home = env.HOME ?? NodeOS.homedir();
  for (const candidate of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (isDirectory(candidate)) return candidate;
  }
  const gradleHome = env.GRADLE_USER_HOME ?? NodePath.join(home, ".gradle");
  const gradleSdk = readProperties(NodePath.join(gradleHome, "gradle.properties"))[
    "systemProp.android.home"
  ];
  if (isDirectory(gradleSdk)) return gradleSdk;
  if (input.repoRoot) {
    for (const file of [
      NodePath.join(input.repoRoot, "android", "local.properties"),
      NodePath.join(input.repoRoot, "local.properties"),
    ]) {
      const sdk = readProperties(file)["sdk.dir"];
      if (isDirectory(sdk)) return sdk;
    }
  }
  for (const candidate of [
    NodePath.join(home, "Android", "Sdk"),
    NodePath.join(home, "Library", "Android", "sdk"),
  ]) {
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/** Variables a check run needs from the machine and the process does not already have. */
export function toolchainEnvironment(input: {
  readonly repoRoot?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env = input.env ?? process.env;
  const variables: Record<string, string> = {};
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    const sdk = androidSdkLocation(input);
    if (sdk) variables.ANDROID_HOME = sdk;
  }
  return variables;
}

/**
 * A short identity of the machine's toolchain. A task parked because of the machine is looked at
 * again when this changes, with no retry spent.
 */
export function toolchainFingerprint(
  input: { readonly repoRoot?: string | undefined; readonly env?: NodeJS.ProcessEnv } = {},
): string {
  const env = input.env ?? process.env;
  return NodeCrypto.createHash("sha1")
    .update(
      [
        `android=${androidSdkLocation(input) ?? "none"}`,
        `java=${env.JAVA_HOME ?? ""}`,
        `android-env=${env.ANDROID_HOME ?? ""}|${env.ANDROID_SDK_ROOT ?? ""}`,
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * Output that says the build cannot run on this machine at all, whatever the code is. Narrow on
 * purpose: a test that prints "permission denied" or "credential" is a test, not a missing tool.
 */
const ENVIRONMENT_SIGNATURES: ReadonlyArray<RegExp> = [
  /SDK location not found/i,
  /(?:ANDROID_HOME|ANDROID_SDK_ROOT)[^\n]{0,80}(?:not (?:set|defined|found)|is invalid|does not exist)/i,
  /JAVA_HOME is not set|Unable to locate a Java Runtime|No Java runtime present/i,
  /Failed to install the following Android SDK packages|Could not determine java version/i,
  /^(?:\S+: )?(?:line \d+: )?\S+: command not found$/im,
];

/** The first line of check output that shows the machine, not the code, is at fault. */
export function environmentFailureOf(output: string): string | null {
  for (const signature of ENVIRONMENT_SIGNATURES) {
    const match = signature.exec(output);
    if (match) {
      const start = output.lastIndexOf("\n", match.index) + 1;
      const end = output.indexOf("\n", match.index);
      return output
        .slice(start, end === -1 ? undefined : end)
        .trim()
        .slice(0, 300);
    }
  }
  return null;
}
