# Crew Office

**A multiplayer office where every player brings their own team of AI employees.** Host an
office on your computer, invite friends, give the office a project, and the agents plan it,
message each other across teams, write the files, run the tests, review the work and
summarise it — in a 2D pixel-art office where every movement is a real backend event.

The multiplayer host, AI teams, message bus, task engine, workers, dashboard and 2D office are
Crew Office's own. [The credits](#credits) say what it is built on.

## Install

**Windows: [download CrewOfficeSetup.exe](https://github.com/lisboaphe/Crew-Office/releases/latest/download/CrewOfficeSetup.exe)
and double-click it.** That is all — no terminal, no npm. It installs for your user only,
checks for Node.js 22.5+ (offering to install it with winget), adds **Crew Office** to the
Desktop and Start menu, plus **Crew Office Worker** and an uninstaller (also listed in
Settings → Apps), and starts it. The setup is not code-signed, so Windows may say *"Windows
protected your PC"*: press **More info → Run anyway**.

Downloaded the source instead (**Code → Download ZIP**)? Unzip it and double-click
**`Install Crew Office.cmd`** in the folder. It does the same as the setup program, from those
files.

**macOS / Linux:** `sh installer/unix/install.sh CrewOffice.zip`, with `CrewOffice.zip` from the
[latest release](https://github.com/lisboaphe/Crew-Office/releases/latest).

**Omarchy / Arch Linux:** from a checkout, `bash installer/omarchy/install.sh` installs what is
missing, builds the package and adds **Crew Office** to the app menu; `crew-office-uninstall`
removes it and keeps your offices.

To build the setup program yourself, `npm run installer` writes it to `dist/`.

Inside the office, **📘 How it works** opens a short tour; it also opens by itself on your
first visit.

## Quick start (from a checkout)

```bash
npm install            # optional: installs the Anthropic SDK used by workers
npm run host           # host an office on this computer → http://localhost:8080/crew
```

Open the lobby, pick a name and a colour, **Host Office**, then add a worker for your agents
(Dashboard → My Crew). To watch the whole thing with no API key, in a second terminal:

```bash
npm run demo           # Alice & Bob, six agents, "Build a simple task management web app"
```

then `npm run app` and choose `Alice` from the players it lists. The demo uses the **scripted test provider**,
which is not AI — its agents follow fixed scripts and say so. With a key:
`npm run demo -- --provider anthropic` (reads `ANTHROPIC_API_KEY`).

| | |
| --- | --- |
| **[Using it](docs/user/multiplayer.md)** | Hosting, joining, LAN and internet play, workers and keys, projects, approvals |
| **[How it works](docs/developer/multiplayer.md)** | Architecture, security model, lifecycles, worker protocol, known limits |
| `.env.example` | Every setting |
| `docker compose up -d` | Dedicated server (Mode B); `--profile worker` adds an always-on worker |

**What is real and what is not.** Agents call real models (Anthropic via the official SDK,
OpenAI, or any OpenAI-compatible local server), use real tools, and produce real files; a
task completes only with evidence the host can check. Internet hosting needs a
connectivity service to be deployed, which is one small program you can run yourself (see
[its deployment guide](docs/developer/connectivity-service.md)). Not built: network
isolation in the default process sandbox (use `CREW_SANDBOX=docker`), and horizontal
scaling. Docker deployment is written but was not run in the environment it was built in.

## Watch the agents you already run

The same office can also show the coding agents on your own computer: Claude Code, Cursor,
Codex, Rovo CLI and OpenClaw sessions each get a character, who walks in, sits at a desk
and types while the agent works. The room *is* the status board.

```bash
npm run serve            # the office, on http://localhost:8080
npm run connect:claude   # or connect:cursor / connect:codex / connect:rovo / connect:openclaw
```

It opens on simulated agents, so it is busy before anything is connected. Start a new agent
session after connecting it. [Connect your agents](docs/user/connect-your-agents.md) covers
each one.

## Documentation

| | |
| --- | --- |
| **[User docs](docs/user/index.md)** | Install it, connect your agents, read the room. Assumes a browser and nothing else. |
| **[Developer docs](docs/developer/index.md)** | How it works and how to change it. Assumes a checkout. |

[Watching the office](docs/user/watching.md) takes two minutes; [getting the
code](docs/developer/getting-the-code.md) is the whole loop for a contributor.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) for humans, [AGENTS.md](AGENTS.md) for
agents. Bugs, questions and proposals go in this repository's issues.

## Credits

Crew Office began as a fork of **[The Roving Office](https://github.com/atlassian-labs/roving-office)**,
by Atlassian, and would not exist without it. The office's server, its Agent Office Protocol
and the plugins that watch your agents all come from that project, under the
[Apache License 2.0](LICENSE). [NOTICE](NOTICE) has the full attribution and says what this fork changes.

Crew Office itself, its code and its art, is by lisboaphe. You are welcome to use it for anything
non-commercial, as long as you credit it. [LICENSING.md](LICENSING.md) has the terms.

The upstream's brand marks are not in this fork: [NOTICE](NOTICE) records how they were
replaced. [Visual assets and their rights](docs/developer/visual-assets.md) gives every
visual asset its source and release basis, and is the place to start if you are adding one.
