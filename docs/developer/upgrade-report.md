# Upgrade report: collaboration, Git, rules and budgets

The state of the upgrade described in the upgrade prompt and change register: what works, what was tested and how, what is not built, and what provider rules block. Status words mean what they say: **Works** was run in a test or by hand as described; **Partial** is usable with the stated gap; **Missing** is not built; **Blocked** depends on a third party.

Recovery point: the Git tag `checkpoint/pre-upgrade-2026-11-03`, on the branch `upgrade/collab-git-budgets`.

## Requirement matrix

| Area | Status | Evidence | Gap |
| --- | --- | --- | --- |
| Host / Join, invitations, roles, room password, LAN discovery | Works | `lib/crew/rooms.cjs`, `lan.cjs`, `test/crew-permissions.test.cjs` | Two real PCs not tried; tests use separate processes and data folders on one machine |
| Host online vs owner's worker online | Works | `workers.cjs`, agent panel, `test/crew-reliability.test.cjs` | |
| Worker runs provider calls and tools on the owner's device | Works | `lib/crew-worker/`, `test/crew-git-collab.test.cjs` checks clones land on the owner's worker only | |
| Durable bus, correlation IDs, loop limits | Works | `bus.cjs`, `test/crew-e2e.test.cjs` | Message retries are job retries; no separate redelivery queue |
| Project → task → job, dependencies, parallelism, retries | Works | `work.cjs`, `jobs.cjs` | Milestones are a label on tasks, not their own screen |
| Self-hosted Git remotes, auth per repository | Works | `git.cjs`, "the host refuses" test | Needs Git installed on the host (the app says so if not) |
| Protected main, no force-push, no deletes, secret scan | Works | `git-hook.cjs`, same test | Scanning is pattern-based; it will not catch every secret |
| Isolated clone per agent per task | Works | `git-local.cjs` | Clones, not `git worktree`, for simpler isolation; same guarantee |
| Smart / Live / Manual sync | Partial | Smart is covered by tests. Manual and Live are implemented in `repo_sync` | Live has no file watcher: it publishes drafts at each sync, not on every save. Live and Manual have no end-to-end test |
| Review with file and line comments, rework, independent reviewer | Works | `reviews.cjs`, review loop test | |
| Merge conflict detection, no overwrite | Works | `test/crew-upgrade.test.cjs` | |
| Snapshots and rollback | Works | same | |
| Definition of Done | Works | `completeTask`, `reviews.request` | Fixed checks driven by rules; no per-task custom checklist |
| Agent rules with inheritance, versions, presets | Works | `policies.cjs`, Rules tab | Task-level rules exist in the API, not yet in the UI |
| Optional progress, handoff and README documents | Works | Progress on/off is tested. Handoff and README checks are implemented, not end-to-end tested | |
| Approval modes | Works | Autonomous and Manual tested; Balanced in the review loop | |
| Audit record | Works | `audit` table, written for approvals, permissions and rules | No audit viewer in the UI yet |
| Shared file store: chunks, resume, hash, versions, quota | Works | `files.cjs`, uploads test, Office files tab | No inline preview; agents' `publish_file` has no end-to-end test |
| Contract dependencies, targeted notification, adaptation | Works | `contracts.cjs`, contract tests | Breaking-change detection understands OpenAPI only; other formats are reported as "changed" |
| Never Use Paid API default, no fallback | Works | Billing tests | |
| Budget Manager, estimates, reserve, concurrency, warnings | Works | `budget.cjs`, budget tests | Lives on the worker's page, not the office HUD, by design: the host must not see it. Team, project and agent scopes are not separate; owner/provider and task are |
| Provider status, Test Connection | Works | `provider-status.cjs` | |
| ChatGPT plan via Sign in with ChatGPT | Partial | `chatgpt-plan.cjs`. On 2026-11-05 a real sign-in succeeded with plan usage allowed, and Test Connection got a real answer, confirmed from the worker's own status | No agent has done a real task on it yet. Token refresh, which the documents do not specify, has not been exercised against the real service |
| ChatGPT plan via the Codex CLI | Partial | `cli-providers.cjs`, tested against a stand-in | Not run against a real CLI or account |
| Claude plan: manual handoff | Works | `handoff.cjs`, handoff test | Inherently manual |
| Claude plan: automated (opt-in) | Limited | Off by default | See below |
| Name-only entry, invite link on hosting, host computer remembered | Works | `auth.enter`, `machine.key`, `test/crew-entry-update.test.cjs` | Clearing cookies loses a joining player's identity |
| Delete office, holiday, fire | Works | `rooms.remove`, same test file | Holiday and fire are the existing pause and remove, renamed |
| App window without a console | Partial | `bin/crew-app.cjs`, run by hand on Windows 11 | It is Edge or Chrome in app mode, not a native shell. Worker still needs a terminal |
| In-app updates from GitHub | Partial | `update.cjs`, tested against a stand-in for GitHub | Windows only; see the matrix note in `multiplayer.md` |
| Global redesign, grouped navigation, animations, reduced motion | Works | `crew/crew.css`, `overlay.js`; checked on screen at 1440x900 | Light mode not checked on screen in this pass |
| AI Connections cards | Works | `connections.js`, `setup.cjs`; worker-security test | Sign-in for Codex and Claude Code has not run against the real tools. Install buttons have not run for real |
| Add Worker wizard, no terminal on the host | Works | `wizard.js`, `local-worker.cjs`; run on screen up to the sign-in step | Not walked through with a real sign-in. Avatar is a colour and initials; there is no image picker |
| Agent editor | Works | `agent-editor.js`; save-and-reopen checked on screen, settings proven in the agent's context | MCP servers are stated as not available. Git worktree and working directory are shown, not settable: each task always gets its own clone |
| Orchestrator: playbooks, runs, monitor | Works | `playbooks.cjs`, `orchestrator.js`, `test/crew-playbooks.test.cjs`; run on screen | Run with the scripted provider only, not a real model. Dragging nodes and connecting by hand were not exercised by a test. Lent agents need their owner to use the existing project lending screen |
| Usage page, warnings, pause line | Partial | `quota.cjs`, usage test | Parsing is tested against the documented shapes, not a real CLI run. ChatGPT plan has no readable figure, so it always says unavailable. Context-window usage is not shown, because nothing reports it |
| Backup AIs, token saver, OpenRouter free models | Works | `router.cjs`, `token-saver.cjs`, `test/crew-router.test.cjs`. Decided in [the 9Router assessment](9router-assessment.md) | Tested against stand-ins. Not run with a real OpenRouter key or across real provider limits |
| Backups | Partial | `createBackup`, tested for creation | Restoring is manual: stop the host and unpack the archive over its data folder. No restore test |
| Agent panel | Partial | Status, connection, tasks, messages, logs | Rules and files are in dashboard tabs rather than the panel |
| Activity feed, Kanban | Partial | Live feed, Task board, Git history | No dependency graph drawing |
| Notifications, quiet mode | Partial | Quiet mode in the browser | Quiet hours and per-kind preferences are missing |
| One-click sandboxed preview | Missing | | |
| Dedicated relay / NAT traversal | Missing | The lobby explains VPN, port forwarding, tunnels | |
| Meeting visuals | Partial | A line between talking agents | Polish phase, as agreed |

## Provider rules, as read on 2026-11-03

**OpenAI.** The Sign in with ChatGPT documents say plan usage "is available to all open-source partners and selected private clients", through OAuth with PKCE, a `127.0.0.1` loopback callback, a dynamic client registration, and the scopes `offline_access resource.invoke chatgpt.tokens.use.direct`. Requests go to `POST /v1/responses` with `store: false` and `stream: true`; function tools are allowed. On `subscription_sharing_usage_limit_exceeded` the app must pause and point to ChatGPT Settings → Usage, and the documents say OpenAI does not silently switch billing paths. This project is Apache-2.0 and runs locally, which is why this route was chosen.

What was verified on 2026-11-05: a real sign-in and one real request, on one account. What is still unverified: the documents do not show the token refresh request, so the standard OAuth `refresh_token` grant is used, and it has not yet run for real. They do not say whether unattended multi-agent use fits the program; a pause on `subscription_sharing_user_not_eligible` will say so if not. The help-centre article on plan usage could not be fetched (403), so its details on the weekly cap are from the prompt, not verified.

**Anthropic.** The Claude Code legal page says developers "should use API key authentication" and that Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users". It also says this does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription", and that running Claude Code in a product requires agreeing to the Commercial Terms, leaving the binary unmodified, and each user authenticating themselves.

So: **manual handoff is the default**. The app prepares the task; you run it yourself in your own Claude Code and press Done. The automated route (`claude-cli`) drives your own unmodified Claude Code, but is **off unless you opt in on your own worker**, and is labelled Limited, because whether unattended orchestration counts as routing requests on your behalf is not something this project can settle. If you need certainty, ask Anthropic, or use an API key, which is permitted and billed separately. The app never handles a Claude sign-in.

**Billing protection, either way.** Paid API is off by default and enforced in `createProvider`, which every model call passes through. The worker removes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and similar from the environment of subscription CLIs, because Claude Code prefers an API key over a signed-in plan when it finds one. Limits pause work; they never trigger a retry or another provider.

## Budget honesty

Providers do not tell apps how much of a subscription remains. So a percentage is of a capacity **you** estimate, counted in requests **this worker** made. The worker's page labels requests as measured, the percentage as an estimate, and remaining allowance as unavailable. Enforced for real: the requests counted, the reserve, simultaneous jobs, and pausing at the estimate. Not enforceable: an exact share of your real plan.

## Tests

```bash
npm run test:crew      # the multiplayer suite: 46 tests
npm test               # everything
```

Agents in these tests use the **scripted provider**: fixed scripts, not AI. Everything below the model is real: tool calls, clones, commits, pushes through smart HTTP, the host's diffs, merges, sandboxed test runs. The scripted reviewer does read the real diff to decide. These tests prove the collaboration machinery and say nothing about how well a real model uses it.

| Acceptance test | Result |
| --- | --- |
| 1. Host and join with independent teams; office, HUD and tutorial work | Passes on one PC with separate processes and data folders; two real PCs not tried |
| 2. Agent edits on its own branch, tests, pushes; host records it; reviewer reads it | Passes |
| 3. Changes requested, new commit, review, merge, QA, Definition of Done | Passes (`review loop`) |
| 4. Progress documents on and off | Passes. The README toggle is implemented and not end-to-end tested |
| 5. Permission gates across owners | Passes (`the host refuses`, `crew-permissions`) |
| 6. Contract change, targeted notification, adaptation on its own branch | Passes. The scripted agent's adaptation is a fixed test file, so this shows the routing, not the judgement |
| 7. Manual / Balanced / Autonomous | Passes |
| 8. Quota exhaustion pauses with no paid fallback; overlapping estimates warn | Passes against a stand-in provider returning OpenAI's documented error |
| 9. Network loss during upload resumes; overlapping edits conflict | Passes. Upload resume is tested by stopping and continuing, not by cutting a real connection |
| 10. Real OpenAI and Claude integrations | ChatGPT sign-in and Test Connection pass on a real account; a real task has not been run. Claude is not done |
| 11. Build and launch the desktop app | The `.exe` was run on Windows 11 and installs and starts the app. Its first real run installed nothing and exited 0, because a batch file launched from the package never ran; it now launches PowerShell directly. No automated test runs the `.exe`. The app is a local server and browser page, not a native window |

## Checklist for real connections

1. Install the app on your PC. Open the office and connect a worker (Dashboard → My workers).
2. Open the worker's page, `http://127.0.0.1:8790`.
3. **ChatGPT:** press Sign in with ChatGPT, then Test Connection. Working means a real answer came back.
4. **Codex:** install it, run `codex login`, press Test Connection.
5. **Claude:** install Claude Code and sign in. Give an agent the manual handoff, assign it a task, and follow the worker's page.
6. Tell the agent's task to do something small, and read what it did under Git / Sync.
7. If anything fails, its error is on the worker's page, and in the crash logs in `~/.crew-worker/crash-logs`.

## Example settings

The bot demo (`npm run demo:bot`: three players, five agents) applies these project rules:

```json
{ "approvalMode": "balanced", "syncMode": "smart", "testsBeforeDone": true, "requireReview": true,
  "progressReports": true, "handoffNotes": true, "updateReadme": false }
```

It also sets a 25% estimated budget on each task, with paid API left off. For that percentage to bite, set a capacity for the connection on the worker's page; without one, only the provider's own limits apply.

## Security notes

On Windows, `test/server-startup.test.js` sets `HOME`, which Node ignores there in favour of `USERPROFILE`, so those tests read the real `~/.roving-office` of whoever runs them, and fail if that folder has offices in it. They are among the failures listed as environmental.


The Git host trusts a worker's commit trailers for test results, so a player could misreport their own agent's tests; it cannot do so for another player's. `run_command` remains Node-only, and the default process sandbox does not block network access; `CREW_SANDBOX=docker` does. Python projects therefore cannot run their tests in the default sandbox yet. Self-hosted traffic is plain HTTP unless you put HTTPS in front of it, so on anything but a trusted network use a VPN or a reverse proxy.
