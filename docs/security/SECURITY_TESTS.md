# Security tests and status

**Automated tests do not prove the absence of sandbox escapes or every possible vulnerability, and passing them does not make this safe for public hosting.** They show the specific boundaries below hold against the specific attacks tried.

```bash
node --test test/crew-security.test.cjs test/crew-relay.test.cjs test/crew-entry-update.test.cjs test/crew-playbooks.test.cjs test/crew-router.test.cjs
npm run test:crew     # every multiplayer test
```

Agents use the scripted provider, so tool calls are real and the decisions are fixed. Tests act as the misbehaving agent or player directly, which is a stronger check of enforcement than hoping a model misbehaves.

## Status

### Implemented and tested

| Requirement | Evidence |
|---|---|
| Balanced by default | `new rooms start Balanced` |
| Normal collaboration across owners (demo test 1) | `review loop` in `crew-git-collab`: a branch, review, sandboxed tests, merge. Accepts the weaker sandbox, as it runs two players on one computer |
| Autonomous keeps boundaries (demo test 5) | same test |
| Private files denied, and recorded (demo test 2) | `Test 2 and 3`: traversal spellings, absolute paths, null bytes |
| No command on the host (demo test 3) | `Test 2 and 3`, plus the host only spawns `git` and `tar` |
| Forged agent identity | `Test 2 and 3`: another worker cannot use a job's lease |
| Malicious repository content (demo test 4) | `Test 4`: hooks and build scripts stored, nothing runs on push, refusal or diff |
| Protected main, no force-push or delete | `Test 4`, `the host refuses` |
| Others' code refused without Docker | `the sandbox refuses another player’s code` |
| A remote host is not believed | same test |
| Sandbox: files, children, network, flags, env, timeout, kill | `sandboxed code: …` |
| Invitations expire and revoke; removed players stay out | `invitations expire…` |
| A room code does not open an office or its activity | `knowing a room’s code…` |
| Emergency stop: queued, tools, new work, persistence, who may resume (demo test 6) | `Test 6` |
| Disconnected worker stops itself (demo test 7) | `Test 7`: the real job loop kills a real process |
| Audit chain detects edits, and members see only their own | `audit records chain…` |
| Delegation depth limit | `delegation chains end` |
| Delegation list enforced | `an agent cannot delegate…` |
| Paid API unreachable by default or as a backup | `no paid API…`, `crew-router` |
| Worker page refuses remote pages and rebinding | `only this computer’s own app…` |
| Host owner is not "whoever is on localhost" | `the app window is remembered…` |
| Friend's worker, task, files and Git through a relay process | `a friend who only knows the relay…` |
| Relay exposes only the office, and cannot count as local | `through the relay only the office is there…` |
| Relay loss and host loss recover on the same address | `losing the relay…`, `when the host goes…` |
| Offices isolated by hostname; relay keys and rate limits | last two relay tests |

### Implemented but not fully tested

| Requirement | What is missing |
|---|---|
| Docker sandbox | Docker is not on the test machine. Arguments reviewed, never run |
| Emergency stop reaching a live worker's stream | Tested at the host and at the sandbox separately, not one real stop through a real worker's stream |
| Security Center UI | Its routes are tested, and stop and resume were pressed once in a real office. No automated test covers the screen |
| New lobby | Host, Join and the hosted page were looked at in a computer-only office. The online states have not been seen on screen |
| Approval expiry after 24 hours | Code path shared with a normal decision; no test waits or fakes the time |
| Installing and signing in through relay on a real friend's PC | Not done |

### Partially implemented

| Requirement | State |
|---|---|
| Capability permissions | Groups, not the brief's finer list. Reading docs and source is one permission |
| Audit coverage | Tools, joins, invitations, approvals, permissions, stops, denials and file reads through one route. Blob downloads and Git pushes are in other records, not this one |
| Resource limits | Time, output, disk, memory, concurrency, messages, delegation. No CPU limit at the process level, and no bandwidth limit |
| Direct connections | LAN only. Over the internet it is always relayed |
| Emergency controls | Everything in the brief through routes. Stopping one project has no button yet |
| Session handling | Revocation on removal. No active-session list per player |

### Not yet implemented

| Requirement | Note |
|---|---|
| OS credential store | Vault key is a file with user-only permissions |
| MCP and external tools | The runner has no MCP client, so there is nothing to govern yet |
| Separate storage process | The room server holds the whole user's file access, with no route exposing it |
| End-to-end encryption through a relay | Not possible for browser clients: see `NETWORK_SECURITY.md` |
| A public relay | None exists. Someone must run one |
| Reviewing dependencies with established tooling | Host has none at runtime. `npm audit` not run in CI |

### Blocked by what is available here

| Test | Why |
|---|---|
| **Two real computers** | One PC here |
| **Different internet connections, CGNAT, restrictive NAT** | Needs real networks and a deployed relay |
| Docker sandbox behaviour | Docker not installed |
| Real model facing prompt injection | Needs a real model and a real attempt |

## Do this before unattended autonomous agents on the internet

Run with a real friend or a second PC. These are the ones that cannot be done from one computer.

1. Deploy a relay. Host on PC A, and invite PC B from a different connection, such as a phone hotspot.
2. On B: join by link with no install. Check the status reads **Connected through relay**.
3. On B: install, add a worker, connect an agent. Run a real task.
4. On B's agent, ask it to read something outside the project. It must be refused, and appear as blocked in A's Security record.
5. Install Docker on A. Give A's reviewer B's code. Check tests run in a container, and that without Docker they are refused.
6. Press STOP ALL AI ACTIVITY on A during real work. Check B's running command dies, and no new work starts.
7. Unplug B's network during a job. Check its process stops within about two minutes.
8. Close A. Check B sees the offline page, then recovers when A returns.
9. Remove B. Check the old link no longer works.
10. Check your AI provider's billing shows no charges.

## Release checklist

- [ ] `npm run test:crew` passes
- [ ] The list above is still accurate for this release
- [ ] New routes check membership on the host, and are covered by an attack in `crew-security`
- [ ] New agent-run code goes through `sandbox.forContext`, never `sandbox.run`
- [ ] New host code spawns nothing that takes player input
- [ ] Nothing new appears on the relay's allowlist without a reason
- [ ] `docs/security` describes what is built, not what is planned
