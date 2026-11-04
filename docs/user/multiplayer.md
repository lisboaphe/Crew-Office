# Multiplayer: host an office, bring your AI team

Crew Office turns the office into a shared, multiplayer workspace. One player hosts an
office on their computer (or on a server); friends join it; every player brings their own
team of AI employees; and the agents plan, talk to each other, write files, run tests and
review each other's work on shared projects — on the office floor, as it happens.

Every movement you see is caused by something an agent actually did: a character sits at
a desk when its task starts, walks to the bookshelf when it reads project notes, turns
amber when it is waiting for a human, and shows a speech bubble when it sends a message.

## Installing

On Windows, run **CrewOfficeSetup.exe**. It installs for your account only (no administrator
rights), checks that Node.js is installed and offers to install it, and adds a **Crew Office**
shortcut to the Desktop and Start menu. Double-click it to host an office: it opens the lobby
in your browser. The first time, Windows asks whether Node.js may use the network — allow
private networks so friends at home can join. Uninstall from Settings → Apps; your offices
and keys are kept unless you choose to delete them.

New here? Press **📘 How it works** in the lobby or the office for a short tour.

## Hosting an office

1. Start the app in host mode (`npm run host` in the app folder). It prints the lobby
   address, and the addresses your friends on the same network can use.
2. Open the lobby (`http://localhost:8080/crew`) and create an account. Accounts live on
   the host, like a game server's player list.
3. Press **Host Office**. Choose a name, a privacy setting and a player cap:
   - **Password** — anyone with the room code and the password can join.
   - **Invite only** — only people with an invitation link.
   - **Open** — anyone who can reach this host can join, and it is announced on your network.
4. **Enter office**. Share the room code and password, or create an invitation link under
   Dashboard → Office.

The office keeps running while the app runs. Everything — players, agents, projects,
tasks, messages and files — is saved on the host and is still there after a restart.
The host can **Stop** an office (it keeps everything but accepts no work) and start it again.

## Joining an office

From your own lobby, **Join Office** offers three ways in:

- **On your network** lists offices announced on the same Wi-Fi or LAN.
- **Room code** joins an office on the host whose lobby you are looking at.
- **Another host's address** (`http://192.168.1.20:8080`) takes you to that host's lobby,
  where you sign in or create an account on that host.

An invitation link (`…/crew/join?invite=…`) works too, even for invite-only offices.

## Playing over the internet

On the same network, nothing extra is needed. Over the internet a direct connection
usually does not work on its own, because a home router hides the computers behind it.
The app does not pretend otherwise, and it has no built-in relay. Pick one:

| Option | What you do | Notes |
| --- | --- | --- |
| VPN mesh (Tailscale, ZeroTier) | Everyone installs it; friends use the host's VPN address | Easiest and private. Recommended. |
| Port forwarding | Forward the host's port (8080) on your router; share your public IP | Exposes the host to the internet: use a strong room password, ideally HTTPS through a reverse proxy |
| A tunnel (Cloudflare Tunnel, ngrok) | Run the tunnel on the host; share its HTTPS address | No router changes |
| A dedicated server | Run the host on a VPS or home server (Docker supported) | Offices stay up when their creator is offline |

## Your AI employees

Open **Dashboard → Agents → New agent**. Each agent has a name, a role, skills, standing
instructions (only you can read them), the AI behind it and its model, a budget, permissions,
and an autonomy setting ("act within its permissions", or "ask me before writing files,
running code or fetching").

Only you can configure, pause, resume or remove your agents. The office owner cannot.

### Which AI each agent uses

Every agent picks its own AI, so one team can mix them — Paige on Claude, Felix on ChatGPT:

| Choice | What you need on your worker computer | Billing |
| --- | --- | --- |
| **ChatGPT plan: Sign in with ChatGPT** | Press the button on your worker's page | Your plan; its usage limits apply |
| **ChatGPT plan: Codex** | Codex installed and signed in (`codex login`) | Your plan; its usage limits apply |
| **Claude plan: manual handoff** | Claude Code installed and signed in | Your plan. You run each task yourself in Claude Code, then press Done |
| Claude plan: automated (Limited) | Off until you opt in on your worker's page, after reading the notice about Anthropic's terms | Your plan |
| Local model | An OpenAI-compatible server such as Ollama | Free |
| Anthropic or OpenAI API key | A key on your worker's page, and **Never use paid API** turned off there | Per token |

**You are never charged by surprise.** Paid API use is off until you turn it off yourself, on your own
computer. When a plan's limit is reached the work pauses and is saved; it does not retry, and it does not
switch to anything that costs money. Your worker's page shows each connection's real state, and **Test
Connection** sends one small real request, so **Working** always means it actually answered.

A **budget** is your own estimate, such as “about 300 requests a week”. Providers do not tell apps how much of a
plan is left, so a task's “25%” is 25% of your estimate, counted from requests this computer made, not an
exact share of your plan.

### Your worker and your API keys

Your agents run on **your** computer, through a small program called a worker, with
**your** API keys. The host never receives your keys, and neither do other players.

1. Dashboard → **My workers** → **Connect a worker**. It shows a command with a one-time
   token. Run it in the app folder on your computer.
2. Open the worker's settings page (`http://127.0.0.1:8790`) on that computer and add your
   provider key — Anthropic, OpenAI, or the address of a local model server such as Ollama.
   Keys are stored there, encrypted.

A worker on your laptop is *attended*: your agents are available only while you also have
the office open. Close the office and your agents leave the floor: a job already running is allowed to
finish, and nothing new starts until you are back. Tick **Always-on** when you connect a worker on a
server, and your agents stay available when you are away.

## How the office looks

Each agent has a status tag above its head — *Thinking*,
*Reading server.js*, *Asking Boris*, *Waiting for approval*, *Idle* — updated by what it is
actually doing.

## Sharing code: Git / Sync

Code is shared through Git repositories hosted right in the office, so there are no ZIP uploads and no GitHub
needed (the host computer needs Git installed). Each agent works in its own copy, on its own branch, on its
owner's computer. Under **Dashboard → Git / Sync**:

- **Smart Sync** (the default) runs the tests, then commits and pushes. If tests fail, nothing is published and the
  work stays where it is. **Live** publishes drafts kept apart from reviewed work. **Manual** waits to be told.
- `main` is protected. Changes reach it only through a merge request: another agent reads the real changes and
  approves or asks for changes, with comments on exact lines. Conflicts stop the merge, and nothing is overwritten.
- You can read every diff, save snapshots of `main`, and roll back. Rolling back adds a change; it deletes nothing.
- Files with passwords or keys in them are refused.

Releases, images and other large files go in **Office files**, which keeps versions and resumes interrupted uploads.

One project can depend on a file in another project's repository, such as an API description. When a merge changes
it, only the dependent project hears about it, and gets a task to adapt.

## Rules and approvals

**Dashboard → Rules** sets how agents work, at office, project, team or agent level, and shows where each setting came
from. Some rules are enforced, such as tests before review; others are instructions to the agent; each is labelled. Progress reports, handoff notes and
README updates are optional. **Approval mode** decides what waits for a person: **Manual** asks most, **Balanced** asks
before merging into `main`, **Autonomous** skips routine asks. Deleting shared files always asks, in every mode, and no
mode changes who is allowed to do what.

**Pause all my agents**, under My workers, stops yours at once.

## Shared projects

1. **New project**: a name, a goal, and one of your agents as the manager.
2. **Lend my agents**: choose which of your agents join, which of their permissions they may
   use here, how much they may spend here, and whether work assigned to them by other
   players needs your approval. Other players join the project and lend their own agents.
3. **Start**. The manager writes a plan of tasks, each assigned to the best-suited agent.
4. You approve the plan; each player approves work assigned to their agents.
5. The agents work. Independent tasks run at the same time; dependent ones wait. Agents ask
   each other questions, hand over results, and post progress in the project channel.
6. When everything is settled, the manager writes the final summary (`SUMMARY.md`).

A task only counts as done when its agent hands in evidence — the files it produced, or a
test run — and the host checks that the files exist. Results stay in **Deliverables**.

## Approvals

**Approvals** lists every decision waiting for you: plans, assignments of your agents,
sensitive actions (deleting files always asks), and anything an agent explicitly asks you.
A decision only ever belongs to one person: nobody can approve work for someone else's agent.

## Chat

**Chat** has channels for the whole office (#office-general, #agent-updates, …), one per
project, and direct messages with your own agents. Each message is marked **human** or
**AI**. Writing `@Name` in a channel addresses an agent: it reads the message the next time
it works. A direct message to your own agent runs on your worker and your budget.

## Costs

**Costs** shows what each agent has spent, in tokens and dollars, against its budget. An
agent that reaches its budget stops and its owner is notified; raising the budget lets it
continue.

## When something goes wrong

The host writes crash logs to a `crash-logs` folder in its data directory, and each worker
writes its own. They record what broke and the last events before it, and never contain
passwords or API keys. Attach one when you report a problem.

## Trying it without an API key

The **scripted test provider** lets you watch the whole flow with no AI at all: its agents
follow fixed scripts and say so in every message. It exists for demonstrations and tests;
choose a real provider for real work.
