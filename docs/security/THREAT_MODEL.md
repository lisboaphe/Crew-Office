# Threat model

What Crew Office defends, against whom, and what it does not stop. Written from an audit of the code on 2026-11-05. It describes behaviour that exists. `SECURITY_TESTS.md` has the evidence and the gaps.

**The requirement this serves:** another player's AI agent must never gain unrestricted access to my computer because that player joined my office. A trusted friend, an autonomous agent, or an agent following a malicious instruction changes nothing.

**This is not a claim that Crew Office is secure.** It has had no external review, and it has not been tested across two real computers. Do not leave unattended autonomous agents in an internet-reachable office until the two-computer checks in `SECURITY_TESTS.md` have been done.

## Trust boundaries

| # | Boundary | Who is trusted with what |
|---|---|---|
| 1 | Room owner | Runs the host. Sees everything in the host's database, including project contents and messages. Never sees other players' credentials, instructions or local files |
| 2 | Other players | Authenticated by a session cookie. Allowed only what their role and project membership grant, checked on the host |
| 3 | Agents of different owners | Untrusted to each other. Can reach each other only through messages, inside a project both are on |
| 4 | The host's operating system | Nothing from a player reaches it except Git operations on bare repositories and files written under the data folder |
| 5 | Each player's operating system | Their worker runs their agents. Agent-run code goes in a sandbox. The worker takes tools from the model, not commands from the host |
| 6 | The room server | Trusted by its own players for coordination. **Not** trusted by a remote worker to say whether code is safe to run |
| 7 | The orchestrator | Has no privileges of its own. Playbooks become ordinary tasks with ordinary checks |
| 8 | AI providers and local runtimes | Receive what the agent is given. Their answers are untrusted: every tool call is authorised independently of the model |
| 9 | Git repositories | Untrusted input, including hooks, links, submodules and build scripts |
| 10 | Shared project storage | Separate from private files, under the data folder |
| 11 | Sandboxes | Contain code that is assumed hostile. See `SANDBOXING.md` for how far each level can be relied on |
| 12 | The web and dependencies | Untrusted. `fetch_url` blocks private addresses. Package installs do not run: the sandbox only runs `node` |
| 13 | MCP and external tools | **None exist.** The runner has no MCP client, so there is nothing to install or authorise yet |
| 14 | The internet relay | Trusted to pass traffic, by whoever chooses to use it. Can read what passes through it. Never receives AI credentials |

## Attacks and what stops them

| Attack | Stopped by | Remaining risk |
|---|---|---|
| Unauthorised file access | Paths normalised and confined on the host. Project membership checked per request. Sandbox allows only its own temp folder | A sandbox escape, see below |
| Remote command execution on the host | No route or tool does this. Host code starts only `git` and `tar`, with fixed arguments | A bug in Git itself, reachable through pushed data |
| Remote code on a player's computer | An agent's code runs only on its owner's worker, in a sandbox. Code that may be another player's needs Docker, or the owner's explicit acceptance | With acceptance and no Docker, a determined attacker may escape Node's permission model |
| Prompt injection | Tool permissions, project grants and approvals are enforced on the host, whatever the model decides. Messages are labelled as information in the prompt | An injected agent can still misuse the permissions it legitimately holds, such as writing bad code to its own branch. A person or a reviewer has to catch that |
| Malicious Git commits | Protected main, no force-push or delete, fsck on receive, 200 MB push limit, secret scan. Clones disable hooks, symlinks, submodules and global config | Secret scanning is pattern-based. Malicious logic in reviewed code can still merge if the reviewer misses it |
| Compromised dependencies | Nothing installs: the sandbox has no `npm install`. The host has no runtime dependencies | The worker's optional Anthropic SDK, if installed. This also means projects needing packages cannot run tests in the sandbox |
| Credential exfiltration | Credentials exist only in each owner's worker vault. The sandbox gets an empty environment and cannot read the vault. Git tokens go by environment, not command line | Malware already on the machine. The vault's key file sits beside it and is protected by file permissions only, not the OS credential store |
| Cross-user data leakage | Membership checks on project contents, logs and channels. Instructions and memory are owner-only | The room owner can read everything in the host's database, by the nature of hosting |
| Path traversal, symlinks | Normalised and confined. Sandbox and clone skip links. `core.symlinks=false` in clones | |
| Race conditions | Job claims are atomic updates. Approvals check state in one step. Upload finalisation verifies the hash | Not systematically tested |
| Malicious uploads | Staged, quota-limited, hash-verified, never served as active content. The host extracts no archives | No content scanning beyond secrets |
| Agent impersonation | A worker token maps to one owner, and a job's lease to one worker. Sender identity comes from the job, never from the request | |
| Message spoofing and replay | Same. Approvals can be decided once | Sessions have no per-request replay protection beyond TLS |
| Privilege escalation | Roles checked on the host. A member cannot manage invitations, resume a stop, or act on another's agent | |
| SSRF | `fetch_url` runs on the owner's worker, refuses private ranges including CGNAT and mapped IPv6, and refuses redirects | DNS can change between the check and the fetch |
| Denial of service | Rate limits on entry, joins, chat and agent messages. Stream caps. Job, step, wall-clock and output limits. Sandbox concurrency limit. Relay limits | CPU in the process sandbox is unlimited for its 60 seconds. The host itself has no global request limit on a LAN |
| Excessive AI usage | Paid API off by default and never a backup. Budgets. Step limits. Delegation depth and per-project task caps | Subscription allowance is the provider's to enforce |
| Malicious orchestration | Playbooks cannot lend another owner's agent, and every step passes the normal checks | |
| Compromised invitations | 96-bit random, expiring, limited uses, revocable. Removing a player revokes all open invitations | A leaked link works for whoever opens it first, until revoked |
| Unauthorised pushes and merges | Per-repository access, branch prefixes checked in the pre-receive hook, merges only through review | A player can misreport their own agent's test results in commit trailers |
| Accidental destruction | Deleting shared files and rolling back main always ask. Deleting an office needs its name typed | |
| Supply chain of this app | No host dependencies, vendored assets with recorded hashes, updates verified by checksum and pressed by a person | Push access to the release repository can offer code to every install |
| Untrusted output triggering tools | Tools are checked by name against what the job was issued, and each is authorised on the host | |

## Found by this audit and fixed

These were real, in code that looked finished. They are recorded because they are the argument for testing against attacks rather than features.

1. **Removing a player crashed the host for everyone**, through a write to a closed stream.
2. **Sandboxed code had full network access**, including to the worker's own settings page on localhost, which can turn off "Never use paid API".
3. **Knowing a room's code let anyone watch its live agent activity**, and LAN discovery announces codes.
4. **Any room member could read any project's files, notes and job logs.**
5. **Invitations could not be revoked**, and a removed player could come straight back on an old link under a new name.
6. **A worker that lost its host kept running its current command** until that finished.
7. **Node flags such as `--require` and `--env-file` were allowed** in sandbox commands. Tested harmless today, but now refused by an allowlist.
8. **Clones inherited the machine's Git configuration**, including any LFS or filter settings.
9. **Browser crash reports were always refused**, so client errors were never recorded.
