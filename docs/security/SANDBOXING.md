# Sandboxing

Code an agent writes or receives runs through `lib/crew-worker/sandbox.cjs`, on the agent owner's computer. Only `node` commands and `npm test` run, parsed without a shell, so there are no pipes, chained commands or package installs.

## Two levels, and how far to trust each

| | Docker | Process (Node permission model) |
|---|---|---|
| Files | Only its copy of the project | Only its copy of the project |
| Network | None, by the container | Blocked by a guard inside the process, except servers it opened itself |
| Child processes | Up to 128, inside the container | None |
| Memory | 512 MB, hard | 256 MB heap, soft |
| CPU | 1 core | **Not limited** |
| Disk | 64 MB of `/tmp`, plus the project folder | 512 MB, watched every 2 seconds |
| Root | No: unprivileged user, no capabilities, no new privileges | Runs as you |
| Time | 60 s | 60 s |
| A determined attacker | Would need a container or kernel escape. Not impossible, and Docker is not a full security boundary | **Should be assumed able to get out.** Node's documentation says its permission model does not defend against malicious code |

This is why the choice is not left to the agent or the host:

- **Your own solo project:** process level, unless you set `CREW_SANDBOX=docker`.
- **A project shared with anyone, or on a host this worker does not run itself:** Docker when it is installed. Without Docker the command is **refused**, and the agent is told so.
- **Exception:** a worker's owner can accept the process level for others' code, on the Connections page. It warns them. It is off by default.

So on a computer without Docker, other players' code does not run at all. Tests in a shared project report that they did not run, and the push carries that fact. Install Docker Desktop to run shared tests.

A remote host cannot talk a worker out of this: if the office is not on this computer, the host's claim that a project is not shared is ignored.

## Other options considered

| Option | Why not, for now |
|---|---|
| MicroVMs (Firecracker) | The strongest isolation, but Linux only, and needs KVM |
| Windows Sandbox | A real VM boundary, but needs Windows Pro and an optional feature, starts slowly, and is hard to automate |
| WSL2 | Reasonable, but it mounts Windows drives by default, so it needs careful configuration to be a boundary at all |
| AppContainer, Job Objects | Good Windows primitives, but need native code, and this project has no native dependencies |
| macOS `sandbox-exec` | Deprecated by Apple |

Windows Sandbox or a dedicated VM is the next step for anyone hosting strangers' code.

## Stopping

Timeouts, an emergency stop and a lost lease all kill the process tree: `taskkill /T /F` on Windows, process-group kill elsewhere, `docker kill` for containers. Temp folders are removed afterwards. At most two run at once per worker.

## Git in a sandboxed world

Clones disable hooks, symlinks, submodule recursion, `file` and `ext` protocols, LFS smudging, and the machine's global Git config. The environment has AI credentials removed. Pushing stores data and runs only this project's own pre-receive hook, so nothing in a push executes on the host.

## Known limits

- Projects that need packages, or any language but Node, cannot run tests in the sandbox. Python scripts can be written and reviewed, but not run.
- The process level's network guard is code inside the process. It blocks every route ordinary code has, and it was attacked with `fetch`, `net`, `http` and `dns`. It is still not a kernel boundary.
- **Docker mode has not been run on this project's test machine**, because Docker is not installed there. Its arguments are checked; its behaviour is not.
