# Changelog

## Glass interface, new navigation, Memory & Knowledge

### Added

- **A guided tour of the Orchestrator**, pointing at each real control while you try it.
- **Navigation you open by resting the mouse on it**, which stays open until you click elsewhere or press Esc. It replaces the two rows of buttons over the office and the rail inside the dashboard.
- **Memory & Knowledge**: searchable, editable memories for you, your team and a project, each recording the code version it was written against. Agents get relevant ones before they start, per project, and they cannot widen what an agent may do.
- **An interactive code graph** built from merged code, with search, connections and source. It needs the optional [Graphify](https://github.com/Graphify-Labs/graphify).
- **Search by meaning**, with the optional [Mem0](https://github.com/mem0ai/mem0) and a local model you choose. Without it, search matches words.
- **Friends** and **Preferences** pages.

### Changed

- **Dark glass** with blue and violet gradients is now the look of the app. Light glass is in Preferences.
- **Chat** stays on the right, with unread counts per channel. What you are typing and where you have scrolled now survive the office's updates, which used to lose both.

### Fixed

- The tour no longer says internet play needs a VPN.
- **Chat channels** wrap instead of being cut off at the panel's edge, and project channels no longer show their internal ID.
- **On a phone**, the dock has its own row instead of covering the open panel.
- **Updates** now work on a copy built without a Git remote. A copy that already has this problem needs the new installer once.

## Automatic internet invitations

Host Office now makes an office reachable by itself, once a connectivity service is deployed. See [its deployment guide](docs/developer/connectivity-service.md). None is running yet, so until then Host Office says so and offers no link.

### Added

- **One-press hosting.** The app finds its service, connects, checks from outside that the room is reachable, and only then shows an invitation link and room code. It reconnects by itself, on the same link.
- **Room codes** that resolve through the service, are separate from an office's keycard, and can be revoked with their invitation.
- **`crewoffice://` links**, registered by the installer on Windows and Linux, and on Windows again each time the installed app starts, so a copy updated from inside the app gets them too. The app shows which office it is before going there.
- **Direct connections on the same network**, found by room code.
- **A deployable service.** Docker and HTTPS recipes, rendezvous, a page for entering a code, monitoring, and limits on offices per address, code guesses and daily traffic.
- **New Host and Join screens**, with networking details moved under Advanced settings.

### Changed

- A public address now needs proof. "Connected through relay" is replaced by **Internet room available**, shown only after the host has reached itself from outside, and **Relay connection**.
- Only offices being hosted can be joined through the automatic service, and it is only connected while one is.
- A relay address has to be `https://`, other than on this computer.
- An invitation link shows the office and its host and waits for a press, rather than joining at once.

### Fixed

- The relay kept treating a host that hung up politely as connected, so its visitors waited rather than seeing the offline page.
- Malformed data from a host could crash the relay for everyone. It now ends that host's connection.
- After a relay restart, an office could lose its address if its name happened to contain certain characters, breaking links already sent.

## Upgrade: collaboration, Git, rules and budgets (branch `upgrade/collab-git-budgets`)

See [the upgrade report](docs/developer/upgrade-report.md) for the requirement matrix, test results and known limits.

### Added

- **Self-hosted Git.** Per-project repositories on the host over smart HTTP, with authentication, a protected `main`, no force-pushes or deletes, secret scanning, snapshots and rollback, and commit provenance.
- **Agent Git tools.** One clone per agent per task, on its owner's machine; Smart, Live and Manual sync.
- **AI review.** Merge requests, an independent reviewer who reads the real diff, file-and-line comments, rework, conflict handling. Git tasks complete only by merging.
- **Agent rules.** Office → Project → Team → Agent → Task inheritance, shown with its source, versioned, with nine role presets. Optional progress, handoff and README documents.
- **Approval modes.** Manual, Balanced and Autonomous, with safeguards no mode removes.
- **Budget manager and billing safety**, on each owner's worker. Paid API is off by default; estimates are labelled as estimates; limits pause and checkpoint work.
- **Provider connections.** Sign in with ChatGPT; Claude manual handoff; automated Claude Code as an opt-in labelled Limited; connection states and Test Connection.
- **Shared file store** with resumable, verified uploads, versions and quotas, and an Office files tab.
- **Contract dependencies** between projects: targeted notification and an adaptation task.
- **Host backups**, a pause-all button, quiet mode, and a three-player bot demo (`npm run demo:bot`).

### Changed

- A new agent defaults to the ChatGPT plan, never to a paid API.
- `claude-cli` is off unless its owner opts in.
- Finished projects reopen when new work arrives, and are summarised again once it settles.
- The Docker image now includes Git.

### Fixed

- A worker with a bad token could open a Git credential window on someone's screen.
- Project budgets now restart a paused task when raised.
