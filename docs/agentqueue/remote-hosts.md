# Remote build machines

`agentq run` sends queued builds, type-checks, test suites and emulator work to faster machines on the
tailnet before it uses this VM: the Legion Go S first, then the laptop, then the VM's own slot. Agents
call `agentq run` exactly as before; placement, file sync, output and exit codes are handled here.

## Why the remote keeps its own queue

Each remote already runs a queue that GitHub Actions jobs share. The VM never counts a remote's slots
itself: it asks the remote's status, submits, and treats "busy or refused" as "place it elsewhere". A
job that never started is never a failure.

## Configuration

`~/.config/agentqueue/resources.json` gains a `remotes` array, tried in order:

```json
"remotes": [
  { "name": "legion", "client": "/home/ajay/.local/bin/legion", "enabled": true,
    "pathMap": { "/home/ajay/flutter/bin/": "", "/home/ajay/Android/Sdk/": "/home/deck/Android/Sdk/" } },
  { "name": "laptop", "client": "/home/ajay/.local/bin/laptop", "enabled": true, "pathMap": {} }
]
```

`AGENTQUEUE_REMOTE=off` keeps a command on the VM. Tests see no remotes
unless they set `AGENTQUEUE_RESOURCE_CONFIG`.

## Client protocol

`<client> status --json` prints one JSON object and exits 0, or exits 255 when unreachable:

```json
{
  "host": "legion",
  "accepting": true,
  "wakeable": false,
  "reason": null,
  "slots": {
    "heavy_build": { "used": 0, "total": 1 },
    "android": { "used": 0, "total": 1 },
    "job": { "used": 0, "total": 4 }
  },
  "mem_available_mb": 20900
}
```

`<client> run --ws KEY --dir DIR [--cwd REL] --resource CLASS --timeout S [--wait S] --label L -- argv...`

- `CLASS` is `heavy_build` or `android`. `DIR` is the worktree top level, `REL` the command's cwd in it.
- Before the command starts it may exit 75 (preempted), 76 (not accepting), 77 (health refused),
  78 (not admitted within `--wait`) or 255 (unreachable). None of these ran anything.
- When the command begins it prints exactly one stderr line: `[remote] STARTED host=<name> job=<id>`.
- Output streams back with the remote workspace path replaced by `DIR`, so file:line references open.
- Dependencies are installed remotely when the lockfile changed since the workspace's last install.
- After the command, build outputs it produced are copied back into `DIR`: `**/build/outputs/**`,
  `**/build/reports/**`, `**/build/test-results/**`, `build/app/outputs/**`, `dist/**`, `coverage/**`,
  `test-results/**`, `playwright-report/**`, `**/*.apk`, `**/*.aab` (never `node_modules`).
- It then prints `[remote] FINISHED host=<name> exit=<n> run_s=<s>` and exits with the command's code.
- A connection lost after `STARTED` exits 255; the VM reruns the command once elsewhere.
- SIGINT/SIGTERM cancel the remote job.

`<client> wake` brings an idle remote into worker mode under its own safety rules.

## What stays on the VM

Commands without a queued resource (quick ones run immediately), Docker, Postgres, browser and GPU
work, anything bound to a VM device (`ANDROID_SERIAL`), git-dependent checks (`git`, `check:changed`),
argv paths outside the worktree that no `pathMap` covers, and commands remembered as needing the VM.

A remote run that fails because the remote lacks something (exit 127, missing SDK, keystore or a
`/home/ajay` path) reruns on the VM and is remembered for that repository and command for seven days
in `~/.local/share/agentqueue/resources/remote-avoid.json`.
