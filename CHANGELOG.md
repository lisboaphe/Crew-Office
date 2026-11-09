# Changelog

## See an update happening

### Changed

- **Update now shows each step as it happens**: downloading, with a bar and how many megabytes have arrived, checking the download, installing, restarting, and done, after which the new version opens. Before, nothing on screen changed until the whole download had finished.

## Talk to a project's agents in its channel

### Added

- **Project chat with answers.** Write in a project's channel and the project's lead answers; write @Name, or several, and those agents answer, in front of everyone in it. Your own agents answer straight away; another player's reads your message on its next task, and the chat says so. Before, a message there was only read on an agent's next task, so nobody answered.

### Fixed

- **The notification bell shows how many are new.** It lights up, shows the number inside the button, and rings once when something new arrives. The number used to sit outside the button's rounded corners, which cut it off, so nothing showed.

## Autonomous agents

### Added

- **Freedom, for each agent: Limited or Autonomous.** Limited works through the office's tools, as before, and you choose which under Skills & Tools. Autonomous is Claude Code working as itself, with its own tools: reading, writing, running commands, unzipping, installing. It works in its project's folder, and what it makes comes back into the project when it finishes.
- **Let it use the whole computer**, inside Autonomous, for playing alone or with people you trust.
- **Autonomous agents on this computer**, on the worker's page: the most an autonomous agent may reach there, which only the app on that computer can raise. Choosing Autonomous in the app on your own computer sets it too.
- **No agent changes the settings.** While an autonomous agent works, the worker refuses any change that would let agents do more, whoever asks. Every change to those settings is shown to you, and a settings file changed behind the worker's back is put back to safe when it starts, and you are told.

### Fixed

- **The worker no longer stops when an AI program it started quits early**, as Claude Code does when a run is stopped while it is starting.

## Agents can use the .zip files you upload

### Added

- **An uploaded .zip is unpacked for the agents.** The text inside it goes into the project's files, in a folder named after the zip, where every agent on the project can read it and use it in its sandbox. Images, fonts and other binaries stay in the zip, and UNPACKED.md says which. Agents could not open uploads at all before, so a mod template uploaded for them was invisible to them.
- **Unpack for the agents**, beside a .zip already uploaded.
- **Agents are told what has been uploaded**, and where to find the text of a .zip.

## Download a project's files

### Added

- **Download all (.zip)** on a project's Office files and Deliverables: everything its agents wrote and the newest version of each upload, in one file.
- **Office files shows what the agents made**, not only uploads, which left a finished project reading "No files yet".
- **Open folder**, on the computer hosting the office, with where the agents' work is kept. Nobody else is shown the host's folders.

## See whether each agent's AI is working

### Added

- **A light in front of every agent's name**, on the floor, in the agent list and in its panel: green when its AI is working, amber when it has not been proven yet or is the manual Claude Code route, red when it cannot work, and grey when its owner's worker is not running. Point at it to see why.
- **A notification when an AI one of your agents runs on stops working**, saying which agents and what to do.

### Changed

- **An agent's task getting an answer counts as a check**, as **Test Connection** does, so a working Claude Code or ChatGPT no longer reads "Set up, but not tested yet". A sign-out or a plan's limit found during a task shows straight away.
- **Claude Code and Codex signed out on the worker** make the task wait for their owner, as a ChatGPT sign-out does, instead of failing it.

## A folder per project, and fixes found checking the app

### Added

- **Each project has its own folder** on your computer, made the first time one of your agents works on it: **Crew Office Projects** in your home folder, then the office, then the project. Your agents' copies of its repository and the tasks handed to you for Claude Code are in there, so deleting the folder clears an old project away. The office keeps its board, chat, shared files and repository.
- **Remove** on the worker's page takes a hand-off off the list, for one whose office or project was deleted.

### Fixed

- **An agent's AI and model save the moment you choose them.** They used to wait for a Save button at the foot of the panel, so a changed AI was easily left unsaved while the agent went on using the old one.
- **The worker forgets an office that no longer knows it**, instead of retrying it every 10 seconds for ever.
- **Done on a hand-off whose task is gone** says so, instead of an unclear error.
- **The health check names the release** on an installed copy, from the build it was installed from.

## The lobby lamp's own switch

- **Click the lobby's hanging bulb** to start or stop its swing and flicker, or choose in **Preferences → Lobby lamp**. Out of the box it follows the system, so with Windows' **Animation effects** off it hangs still and stays lit, which is why it seemed to have gone.

## Walking, art and layout in the 2D office

### Changed

- **Trips to the break area keep to lanes**: down the aisle, along the walkway at the foot of each room, through the doors, then up to the coffee machine, microwave or water cooler.
- **A stroll stays in the agent's own room.** They walk in a straight line until a wall, desk or plant is in the way, then turn and go another way.
- **Walking is slower and smoother.** People walk at about two thirds of the old speed and are drawn every frame while they move.
- **People go behind furniture properly.** Somebody walking behind a desk, plant or shelf goes behind it, and in front of it once they are past.
- **The walls are charcoal brown.**
- **The break area has no sofa**, and the player's first room has a **cozy corner** at its top left, against the back wall: a yellow arc lamp leaning over a cognac leather armchair, and a plant, on a round rug. The break area has a round table with four chairs.
- **The door and the fax machine are redrawn**, and the characters no longer have stray pixels round their feet and in their hair.
- The office no longer updates the hidden 3D scene every frame.
- The user documentation shows the 2D office, and says which pages describe the old 3D one.

## Small fixes after the 2D office

- The Orchestrator's guided tour closes when you leave the Orchestrator, instead of staying over the office.
- The office no longer logs a "409 Conflict" error on every load.
- **Add an agent** is now called that, instead of **Add a worker**, which is the name of the program that runs agents.
- The tours describe the 2D office.
- The agent roster starts put away in a crew office, and **Agent roster** in the menu shows it.
- New offices start with two chat channels instead of five; add more with **+** in the chat.
- **Revoke Invitation** only shows when there is an invitation link to revoke.

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
- **The scene menu** no longer shows light text on a white background, and the office's controls and the top-right controls now line up.
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
