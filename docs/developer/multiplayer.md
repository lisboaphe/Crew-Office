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
  auth.cjs         names, sessions (HttpOnly cookie, digest stored); password accounts for demos and tests
  update.cjs       in-app updates from GitHub releases (see "Releases and updates")
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
  lan.cjs          UDP discovery on the local network, and slow hashes of room codes for direct joins
  relay-client.cjs finding the service, the tunnel, proving reachability, publishing codes
  demo-kit.cjs     driving a room from code (demo script, tests)
lib/relay/
  frames.cjs       the tunnel's wire format
  invitation.cjs   what counts as an invitation or room code; shared by app, host and relay
lib/crew-worker/
  main.cjs         the worker program and its loopback settings page
  worker.cjs       one host connection: stream, claim, run, reconnect
  runner.cjs       the bounded, cancellable, resumable model⇄tools loop
  providers.cjs    Anthropic (SDK), OpenAI / local (OpenAI-compatible), scripted
  cli-providers.cjs  Claude Code and Codex on the owner's subscription, via a JSON tool protocol
  scripted.cjs     the scripted test provider (not AI)
  schemas.cjs      tool descriptions and JSON Schemas for models
  local-tools.cjs  sandboxed commands, web fetch, private memory
  git-local.cjs    the agent's own clone of a project repository, and its Git tools
  handoff.cjs      the manual Claude Code route: brief out, RESULT.md or PLAN.json back
  health.cjs       what real work says about each AI: answered, signed out or at its limit
  native.cjs       an autonomous agent: Claude Code as itself, in its project folder or anywhere
  provider-status.cjs  each AI's state for the office, from tests and from health.cjs
  project-folders.cjs  one folder per project on the owner's machine, for clones and hand-offs
  sandbox.cjs      process (Node permission model) or Docker isolation
  vault.cjs        encrypted credential store
crew/              lobby and in-office overlay (no build step)
bin/crew-host.cjs  `npm run host` / `npm run dedicated`
bin/crew-worker.cjs, bin/crew-demo.cjs
bin/crew-relay.cjs the connectivity service. See [Deploying the connectivity service](connectivity-service.md)
deploy/relay/      its Docker deployment
```

## Project folders on the worker's machine

Everything a worker keeps for a project, its agents' clones and the manual hand-offs, goes in one
folder for that project, so a project is cleared away by deleting it:

```
<projects root>/<office name>/<project name>/
  .crew-project.json        the project's id, so a renamed project keeps its folder
  agents/<agent>/<task (id)>/<repository>
  handoffs/<task (id)>/HANDOFF.md, RESULT.md or PLAN.json
```

The root is `CREW_PROJECTS_DIR` if set. Otherwise the worker that somebody runs uses
`~/Crew Office Projects`, outside synced folders because clones churn files, and a worker started
with its own `CREW_WORKER_DIR` uses `Projects` inside that. Anything else that builds the worker's
tools, a test or the demo, gets `Projects` inside its data folder, so nothing but a real worker
ever writes to somebody's home folder. Hand-offs are still listed in `<data dir>/handoffs`, which
the worker page reads; each entry records the folder its files are in. A clone made before this
layout stays where it is and is used until its task ends.

A connection whose token the office answers with 401 *Unknown or revoked worker token* is
forgotten from `worker.json` and stops, since waiting never makes such a token valid again. Any
other failure to reach the office is retried every 10 seconds as before.

## Downloading a project

`GET …/projects/:project/download.zip` (`lib/crew/api.cjs`, built by `lib/crew/zip.cjs`) puts a
project's agent-written files under `Agents' work/` and the newest version of each upload under
`Office files/`, for the same people as any other project read. The zip is made in memory, so it
stops at 200 MB and lists what it left out in `NOT INCLUDED.txt`. `…/folder` and `…/folder/open`
give the host's path and open it, and only to `ownerOfComputer`: a request on the host machine,
not forwarded, holding its machine key. Everybody else gets `null` and 403.

Uploads (`lib/crew/files.cjs`) are binary and outside what agents read, so finalising one whose path
ends in `.zip` calls `crew.work.unpackZip`, and `POST …/blobs/:blob/unpack` does the same on request.
`readZip` in `lib/crew/zip.cjs` refuses archives over 5,000 entries or 100 MB unpacked, any entry
whose path leaves the archive, and any that inflates past the size it declares. Valid UTF-8 without
NUL bytes, up to the 256 KB file limit, is written as project files under `<upload without .zip>/`,
dropping a single top folder such as GitHub's `<repo>-main/`; the rest is listed in `UNPACKED.md`.

## Autonomous agents

A limited agent thinks through a model and acts only through the office's tools. An autonomous one
(`lib/crew-worker/native.cjs`) is Claude Code run as itself in a folder, given the task as
`.crew/TASK.md`, which reports through `.crew/RESULT.md` or `.crew/PLAN.json`. `importResult` in
`handoff.cjs`, shared with the manual route, turns that into `submit_plan`, `review_decision`,
`repo_sync` and `request_merge`, or `complete_task`. Without a repository, the project's shared
files are mirrored into `<project folder>/workspace` first, and new or changed text files are
written back afterwards with `write_file`, so every rule on those tools still applies.

How far it reaches is `reachOf(agent, ceiling)`: the smaller of the agent's `freedom` (in its
profile, kept by the office's host) and the worker's `autonomous` setting (`off`, `project` or
`computer`, in the worker's own settings). The worker's page only accepts changes from a page
served by this computer, so an office's host can ask for more but never get it. `project` is
`claude -p --restricted` with commands and web tools named and allowed: Claude Code confines its file
tools to the working folder, which was checked by asking it to write outside and seeing it refused,
but not what a command touches. `computer` is `--dangerously-skip-permissions`.

No agent may change the settings that bound it. None of the office's tools can (a test lists them).
On the worker, `budget.update(patch, { locked })` refuses, with 423, any change `widening()` names,
while `autonomousWorking()` counts a run: an autonomous agent's command could otherwise post to the
worker's page, which cannot tell a script from the owner. The guarded settings' fingerprint is kept
in the vault as `settingsSeal`, so a `settings.json` edited outside the worker is reset to the
defaults at start and reported to the owner. An agent with `computer` reach runs as the owner and
could defeat both; that is why it is opt-in on both sides.

## Security model

**Identity.** A player is a name and a colour, per host, created by `POST /api/crew/enter`
with no password. The session cookie is the identity and lasts a year. Accounts never kept
strangers out, since anyone who could reach a host could register; what keeps them out is the
room's privacy. What a password did do is stop someone *being* you, so a name is deliberately
not a credential: entering an existing name makes a new player. `register` and `login` remain
for the demos and tests; the UI no longer reaches them. New players are rate-limited per address.

**The owner of the host computer** is remembered, so the app never shows them a name screen
twice. Being on that computer is deliberately not enough, because the owner's agents are too,
and a loopback check would let one approve its own work as its owner. So `ownerOfComputer()`
needs both `localMachine()` (a direct loopback connection to a local hostname with no forwarding
headers, since a tunnel also connects from loopback) and `machine.key` from the crew data folder.
`bin/crew-app.cjs` reads the key and puts it in the window's address as `?this-pc=`; the lobby
trades it for an HttpOnly, SameSite=Strict cookie and strips it from the address. The key also
guards updates, switching player and deleting a player. This holds against an agent only while
the sandbox keeps it out of the data folder: `CREW_SANDBOX` must not be widened to include it.

**Deleting an office** (`rooms.destroy`) removes rows by column, every table with a `room_id` or
`project_id`, so a table added later cannot be forgotten, plus the three that only reach a room
through another row, and the room's files and bare repositories. The API re-checks the typed name.

Browser requests authenticate with a session cookie; state-changing requests also need `X-Crew: 1`, which a cross-origin page cannot send
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

## Status tags

The tags above agents come from the host's `activity` hub events (`lib/crew/office.cjs`),
sent at each job start, tool call, wait and idle.

## The browser, the worker and the host

`crew/connections.js` talks straight from the page to the worker on the same computer, so a
sign-in state or usage figure never passes through a room host. The worker allows this only from
`http://localhost` and `http://127.0.0.1` origins, and checks `Host` on every request. A remote
office's page is refused on purpose: it is code from someone else's machine, and it could
otherwise turn off "Never use paid API". Players on a remote host use the worker's own page,
which serves the same module from `/ui/`. `test/crew-playbooks.test.cjs` holds this line.

`lib/crew/local-worker.cjs` lets the host's own app start a worker without a terminal. It is
behind `ownerOfComputer()`, and the token goes directly to the worker rather than through a page.
That worker stops with the office. One someone started by hand is left alone.

## Agent settings

`lib/crew/profiles.cjs` holds what is not on the agents row. Its text is appended to the agent's
standing instructions on every job (`buildContext`), the orchestration role steers reviewer
choice, and `delegationTargets` is enforced in the `delegate_task` tool. Toggles in the editor are
rules at agent scope, through the existing policy chain, so they are enforced where rules already
are. `crew/agent-editor.js` redraws only its header on live events, so a form is never reset
while someone is typing. MCP servers are deliberately not offered: the runner has no MCP client,
and the panel says so rather than showing a control that does nothing.

## Playbooks

`lib/crew/playbooks.cjs` compiles a graph into an ordinary project. Work nodes become tasks with
the graph's dependencies. Condition, Approval, Merge and Completion become tasks of kind `gate`
with no agent, settled by `tick()`, which runs with every scheduling pass. A graph is copied into
its run, so editing a playbook cannot change a run already going. Starting a run lends only your
own agents; another player's are requested, and `tick()` assigns the work once they lend them.
The Merge node verifies rather than merges, because merging belongs to the review flow.

Alethe was the reference. `alethe-agents` is AGPL-3.0, and copying from it would put this
Apache-2.0 project under AGPL, so nothing was taken from it. `alethe-orchestrate-skill` is MIT;
the idea of named strategies and the field shapes of the CLI usage events come from it, and
`NOTICE` credits it. The implementation is original.

## Usage figures

`lib/crew-worker/quota.cjs` records only what the official CLIs printed during a run this worker
made: Codex's `rate_limits` and Claude Code's `rate_limit_event`. Neither is a promised interface,
so a reading that does not parse is dropped, and a new CLI version could make these figures
disappear rather than go wrong. Alethe also reads Codex's session files and has usage polling
for other tools; this does not, because those are undocumented sources of the same data. ChatGPT
plan usage has no documented reading at all. A reading stops counting once its window has reset,
and stops pausing work once it is six hours old.

## Security and the relay

The threat model, permissions, sandbox levels, relay design and test status are in `docs/security/`. Those describe what is enforced, and where. Read `SECURITY_TESTS.md` before relying on any of it.

## The app window

`bin/crew-app.cjs` is what the shortcuts run. It starts itself again as `--serve`, detached
and with no console, writing to `app.log` in the crew data folder, then opens Edge or Chrome
with `--app=` and a dedicated `--user-data-dir`. The server watches the lock the browser holds
in that profile and stops when it is released, which is how closing the window stops the
office. It watches the lock rather than the child process because a second launch hands off to
the first and exits at once. With neither browser installed it falls back to a console and the
default browser. Set `CREW_APP_NO_WINDOW=1` to force that fallback, or `=headless` to also skip
opening a browser.

## Releases and updates

`.github/workflows/release.yml` runs on every push to `main`: the multiplayer tests, then
`installer/build.cjs`, then a GitHub release tagged `build-<run number>` with
`CrewOffice.zip`, its `.sha256`, and the setup program. The build stamps `build.json` into the
app, naming the build number, commit and repository. A build made by hand is build 0 of
whatever `origin` points at, so any release is newer than it.

`lib/crew/update.cjs` asks `GET /repos/<repo>/releases/latest`, at most every ten minutes and
only when the host's own app opens a page. The routes refuse anyone but `ownerOfComputer()`.
Installing downloads the zip, checks the checksum, copies `install.ps1` out of the folder it is
about to replace, starts it detached and stops the server. The installer waits for the server
to exit, builds the new copy beside the old one, swaps the folders by renaming, and starts the
app again whether or not that worked, so a failure leaves the old build running. The reason is
in `update.log` in the crew data folder. The page polls `host-info` and reloads when the build
changes.

The checksum catches a damaged download. It does not protect against a compromised repository,
since it is published in the same place: **push access to `main` is the ability to offer code
to every installed copy.** So protect the branch, and keep the tests in the workflow.

Set `CREW_UPDATE_API` to point the updater at a stand-in for GitHub. `deploy.yml` is off unless
the repository variable `DEPLOY_TO_FLY` is `true`.

## The host's time and weather

`GET /api/crew/host-conditions` gives the host's time and the weather, so the office's clock and windows match the host's computer for everyone looking at it. `lib/crew/host-conditions.cjs` asks Open-Meteo, at most every half hour, with a location rounded to one decimal place and nothing else. The location is `CREW_WEATHER_LAT` and `CREW_WEATHER_LON`, or a guess from the time zone on systems with a zone table. Without one, with `CREW_WEATHER=off`, or if the service is down, the window shows a clear sky.

## Known limits

- Updating inside the app is Windows only; macOS and Linux get a link to the release.
- A worker also runs from the app folder, so an open worker window blocks an update, which then
  stops and says so. Workers are not updated or restarted for you.
- Clearing cookies costs a player joining someone else's host their identity and their agents.
  There is no recovery key yet. Only the host computer's owner is remembered beyond a cookie.
- Internet hosting needs a deployed connectivity service, and a build that knows its address.
  Over the internet all traffic goes through it: there is no hole-punching. Direct connections
  are for hosts on the same network.
- The `crewoffice://` handler is registered on Windows and Linux, not macOS, where that takes an
  app bundle. The https link works everywhere.
- The process sandbox does not block network access; use Docker mode where that matters.
- Agents' sandboxed runs see a copy of the files; their changes are not synced back.
- The host trusts what a worker reports about usage and test runs. A player can only
  misreport their own agents' work, and the reports are labelled with whose worker ran them.
- Only Anthropic models are priced out of the box; OpenAI prices are approximate and local
  models cost $0.
- One host process per data directory; there is no horizontal scaling.
