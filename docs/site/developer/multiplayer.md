# The multiplayer layer

How the shared office works: rooms, players, owner-side workers, the message bus, the
task engine, and the bridge that makes the 3D office show what the agents are doing.

## Shape

```
 browser (player)            room host (server.cjs + lib/crew)            worker (each player's machine)
 ────────────────            ─────────────────────────────────            ──────────────────────────────
 /crew lobby  ── HTTP ──▶    accounts, rooms, invites, roles              lib/crew-worker/main.cjs
 /office/<code>              SQLite: everything durable                   vault: the player's API keys
   3D office ◀── AOP SSE ─   office bridge → per-room AOP bus             provider adapters (Anthropic SDK,
   overlay   ◀── crew SSE ─  realtime hub: presence + events                OpenAI-compatible, scripted)
             ── HTTP ──▶     message bus · projects · tasks · approvals   runner: model ⇄ tools loop
                             durable job queue (leases) ◀── claim ───────  local tools: sandbox, fetch,
                             host tools (permission-checked) ◀── RPC ────    private agent memory
```

The **host is authoritative** for shared state: membership, roles, agent configurations,
task ownership, approvals, budgets, messages and project files. The **worker is
authoritative for nothing shared** — it holds what must never leave its owner's machine:
provider credentials, private agent memory, and resumable checkpoints of jobs it runs.

Every connection is initiated by a browser or a worker, never by the host, so workers
behind NAT need no open port. Only the host must be reachable.

## Why these technologies

- **No new runtime dependencies on the host.** The office was built with none, and the
  multiplayer host keeps it that way: Node's built-in `node:sqlite` for persistence, plain
  `http`, Server-Sent Events for realtime. The one dependency is the official Anthropic SDK,
  used only by workers (optional).
- **SSE + HTTP rather than WebSockets.** The office already streams AOP over SSE; SSE
  reconnects by itself with `Last-Event-ID`, passes through proxies, and every write is an
  ordinary authenticated request. The hub keeps a 500-event replay buffer per room and tells
  a client that fell further behind to `resync` (refetch the snapshot).
- **Host-driven visuals through AOP.** `lib/crew/office.cjs` speaks the Agent Office
  Protocol into each room's existing bus under harness `crew`. The 3D engine, reducer and
  character behaviours are unchanged: `turn.start` puts work on a desk, a `search`/`knowledge`
  tool sends a character to the bookshelf, `permission.request` turns them amber, `turn.end`
  delivers. Speech bubbles and conversation lines have no AOP vocabulary, so they travel on
  the crew hub and the overlay pins them to characters via `window.officeView`.

## Files

```
lib/crew/
  index.cjs        assembly, boot recovery, background sweep
  db.cjs           SQLite schema (append-only migrations) and helpers
  auth.cjs         accounts (scrypt), sessions (HttpOnly cookie, digest stored)
  rooms.cjs        rooms, privacy, password, cap, invites, roles, `can()`
  hub.cjs          per-room SSE, replay buffer, presence with a reload grace
  agents.cjs       agent CRUD; owner-only control; availability; usage
  workers.cjs      worker tokens, liveness, attended vs always-on, nudges
  bus.cjs          channels, DMs, structured messages, correlation, loop guards
  jobs.cjs         durable queue: idempotent enqueue, leases, retries, cancel
  work.cjs         projects, grants, tasks, planning, approvals, files, notes, scheduler
  host-tools.cjs   shared-state tools executed for workers, after permission checks
  office.cjs       backend events → AOP → the 3D office
  api.cjs          HTTP routes (browser and worker)
  catalog.cjs      permissions, tools, states, prices — shared with workers
  crash.cjs        crash logs (redacted)
  lan.cjs          UDP discovery on the local network
  demo-kit.cjs     driving a room from code (demo script, tests)
lib/crew-worker/
  main.cjs         the worker program and its loopback settings page
  worker.cjs       one host connection: stream, claim, run, reconnect
  runner.cjs       the bounded, cancellable, resumable model⇄tools loop
  providers.cjs    Anthropic (SDK), OpenAI / local (OpenAI-compatible), scripted
  cli-providers.cjs  Claude Code and Codex on the owner's subscription, via a JSON tool protocol
  scripted.cjs     the scripted test provider (not AI)
  schemas.cjs      tool descriptions and JSON Schemas for models
  local-tools.cjs  sandboxed commands, web fetch, private memory
  sandbox.cjs      process (Node permission model) or Docker isolation
  vault.cjs        encrypted credential store
crew/              lobby and in-office overlay (no build step)
bin/crew-host.cjs  `npm run host` / `npm run dedicated`
bin/crew-worker.cjs, bin/crew-demo.cjs
```

## Security model

**Identity.** Accounts are per host. Browser requests authenticate with a session cookie;
state-changing requests also need `X-Crew: 1`, which a cross-origin page cannot send
without a CORS preflight the host never grants. Workers authenticate with a bearer token
minted by their owner; the host stores only its SHA-256.

**Ownership.** An agent is controlled by its owner only (`agents.owned()`), whatever the
owner's room role. Room roles (`guest < member < admin < owner`) govern the room: who may
create agents and projects, invite, manage players, change settings, stop the room.

**Grants.** An owner lends an agent to a project with a subset of its permissions, a
project budget, and `requiresApproval`. The tools a job is issued are recomputed on every
call as *agent permissions ∩ grant permissions* (`host-tools.issuedTools`), so revoking a
grant takes effect mid-job. Assigning work to an agent whose owner did not request it
creates an approval only that owner can decide — the project creator, the manager agent and
the room owner cannot bypass it.

**Cross-team communication.** An agent may message or ask another agent only if both are
granted to the project the job belongs to (or share an owner). Messages are data in the
recipient's prompt, never authority: the system prompt says so, and nothing in a message
changes what tools the recipient holds.

**Credentials.** Keys live in the worker's vault (AES-256-GCM, key file beside it) or its
environment. They are only ever sent to the provider. The end-to-end test asserts a key in a
worker never appears in the host's database or in any API response. The sandbox child gets
an empty environment.

**Execution.** `run_command` runs Node only, parsed without a shell, against a temporary
copy of the project files, with a 60 s limit and capped output. Default isolation is
Node's permission model: filesystem confined to the copy, no child processes, no workers, no
addons — **network is not blocked** at this level. `CREW_SANDBOX=docker` uses a container
with no network, 512 MB, one CPU and a process limit. `fetch_url` refuses private and
loopback addresses and redirects. Files a command changes are not synced back; deliverables
are written with `write_file`, which the host confines to the project directory.

**Approvals.** `delete_file` always asks; agents set to `ask` ask before writing files,
running code, fetching or delegating; `request_human_approval` asks explicitly. A parked job
checkpoints its transcript on the worker (it can contain private memory) and is requeued
with the decision.

**Static files.** The host refuses dotfiles and `node_modules`, so a `.env` beside the app
is never served.

## Lifecycle

Agent states: `IDLE → ASSIGNED → PLANNING | WORKING | REVIEW → (WAITING) → COMPLETED`, plus
`FAILED`, `PAUSED`, `CANCELLED`, `BLOCKED` (budget) and `OFFLINE` (no worker / owner away).

Task states: `pending → awaiting_approval → queued → in_progress → (waiting) → completed`,
plus `failed`, `cancelled`, `blocked` (a dependency failed, or budget). The scheduler queues a
task only when its project is active, its approval is clear, every dependency is completed
and its grant has budget left. A task job that ends without `complete_task` is a failed
attempt; attempts are bounded (`max_attempts`), and the next attempt is told why the last
failed. When every work task is settled the manager gets a `synthesis` task.

Jobs are leased for 90 s and extended by every heartbeat and tool call. A worker that goes
quiet for 35 s loses its leases without losing an attempt; a lease that simply runs out
counts as a failure. On host restart, leased jobs return to the queue.

Conversation limits: 20 messages a minute per agent, 10 messages between any two agents per
task, a refusal for repeating the same message, and `ask_agent` chains at most two deep.

## Worker protocol

All `POST` JSON with `Authorization: Bearer wk_…`.

| Route | Purpose |
| --- | --- |
| `GET /api/crew/worker/whoami` | Which room, which player, which agents |
| `GET /api/crew/worker/stream` | SSE nudges (`jobs`); also keeps the worker online |
| `POST /api/crew/worker/claim` | Lease one runnable job for this player's agents; returns its context |
| `POST /api/crew/worker/heartbeat` | Extend the lease; learn of cancellation |
| `POST /api/crew/worker/tool` | Run a host tool `{jobId, name, args}` |
| `POST /api/crew/worker/authorize` | Ask before a local tool `{jobId, name, summary}` |
| `POST /api/crew/worker/usage` | Report tokens and cost; the answer may say stop |
| `POST /api/crew/worker/finish` | `done`, `failed`, `waiting` or `cancelled` |
| `GET /api/crew/worker/files?jobId=` | Project files for a sandboxed run (needs `files.read`) |

## Testing

```bash
npm run test:crew     # multiplayer tests only
npm test              # everything
```

`test/crew-e2e.test.cjs` is the required demo as a test: a real host process, two players,
two workers, six agents, plan and assignment approvals, cross-team questions answered on the
same correlation id, files, a sandboxed test run, a review, the summary, credential
isolation, and a host restart with nothing lost. It uses the scripted provider, so it runs
offline. Other `test/crew-*.test.cjs` files cover permissions, the bus, jobs and leases,
reconnection, the sandbox and crash logs.

## Subscription providers

`claude-cli` and `codex-cli` run the owner's own Claude Code (`claude -p --output-format json
--tools "" --strict-mcp-config`) or Codex (`codex exec --json --sandbox read-only` in an empty
temp folder) once per turn, statelessly, with the transcript on stdin. Built-in tools are off
(Claude Code) or have nothing to act on (Codex); the office's tools are described in the
prompt and the model answers with one JSON object of tool calls, which the runner executes
like any provider's. Cost is reported as $0 (the plan's limits apply). `CREW_CLAUDE_CLI` /
`CREW_CODEX_CLI` override the commands. Tested against stand-in executables
(`test/crew-cli-providers.test.cjs`), not against signed-in CLIs.

## Pixel-art rendering

`src/main.js` draws the scene at 1/`office.pixelScale` of the screen resolution (default 2,
from `localStorage`) with anti-aliasing off, and the canvas is upscaled with
`image-rendering: pixelated`. Status tags come from the host's `activity` hub events
(`lib/crew/office.cjs`), sent at each job start, tool call, wait and idle.

## Known limits

- No built-in relay or NAT traversal: remote play needs a VPN mesh, port forwarding, a
  tunnel, or a dedicated server.
- The process sandbox does not block network access; use Docker mode where that matters.
- Agents' sandboxed runs see a copy of the files; their changes are not synced back.
- The host trusts what a worker reports about usage and test runs. A player can only
  misreport their own agents' work, and the reports are labelled with whose worker ran them.
- Only Anthropic models are priced out of the box; OpenAI prices are approximate and local
  models cost $0.
- One host process per data directory; there is no horizontal scaling.
