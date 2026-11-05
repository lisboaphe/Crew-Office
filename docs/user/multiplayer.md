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
shortcut to the Desktop and Start menu. Double-click it and Crew Office opens in its own
window. The first time, Windows asks whether Node.js may use the network — allow private
networks so friends at home can join. Uninstall from Settings → Apps; your offices and keys
are kept unless you choose to delete them.

The window is Microsoft Edge or Google Chrome running in app mode, with a profile of its own.
Without either one, Crew Office opens in your default browser and keeps a console window open
instead; closing that console stops the office.

New here? Press **📘 How it works** in the lobby or the office for a short tour.

## Updates

When a new build is out, **Update available** appears at the top of the lobby and the office,
on the computer that hosts it. Nothing installs until you press it. The app checks the
published build's checksum, replaces itself, and comes back within about a minute; your
offices, projects and sign-ins are kept. Everyone in the office is disconnected until then.

Close any worker window first. A worker runs from the same folder, so while it is open the
update stops and tells you, leaving the app as it was. Updating inside the app is Windows
only for now; on macOS and Linux the button takes you to the download page.

To look for updates the app asks GitHub for the latest build, so GitHub sees that request
come from your address. Other players' copies are not involved: a player only needs the
host's address, and uses whatever the host runs.

## Hosting an office

1. Open Crew Office. Pick a name and a colour; that is all it asks, and this browser remembers
   you.
2. Press **Host Office**. Choose a name, a privacy setting and a player cap:
   - **Invite link** — only people you send the link to. This is the default.
   - **Password** — anyone with the room code and the password can join.
   - **Open** — anyone who can reach this host can join, and it is announced on your network.
3. Copy the invitation link it shows and send it to the people you want. It works for 72
   hours and 20 people; make more under Dashboard → Office.
4. **Enter office**.

The office runs while the Crew Office window is open, and **closing the last window stops it**.
To keep one running without a window, use `npm run host` from a checkout, or a
[dedicated server](#playing-over-the-internet). Everything — players, agents, projects, tasks, messages
and files — is saved on the host and is still there after a restart. The host can **Stop** an
office (it keeps everything but accepts no work) and start it again.

### Your name

A name is a label, not a login. Two people can share one, and typing somebody's name makes you
a new player who happens to have that name: it gives no access to their agents or their plan.

**On the computer hosting the office**, the app remembers you. Open it from its shortcut and you
go straight in, with no name screen, because the app holds a private key file kept on that
computer. The first time, it asks who you are and lists the players it already has. Press your
name in the lobby to change your name or colour, switch player, or delete a player you no
longer want. Opening the office in an ordinary browser instead does not have the key, so a name
typed there makes a new player.

**When you join someone else's office**, your browser is what makes you you. If you clear its
cookies, use another device, or open the office at a different address, you come back as a new
player, and your old agents stay with your old self.

### Deleting an office

The owner can delete an office from the lobby, or under Dashboard → Office. You type its name to
confirm. It permanently removes the office's projects, tasks, messages, files, Git repositories
and agents, and sends everyone in it back to the lobby. Export the office first if you want a
copy. To keep everything and just stop it for a while, use **Stop** instead.

## Joining an office

From your own lobby, **Join Office** offers three ways in:

- **On your network** lists offices announced on the same Wi-Fi or LAN.
- **Room code** joins an office on the host whose lobby you are looking at.
- **Another host's address** (`http://192.168.1.20:8080`) takes you to that host's lobby,
  where you pick a name for that host.

If someone sent you an invitation link (`…/crew/join?invite=…`), just open it in a browser:
pick a name and a colour and you are in. You do not need to install anything to join; you
only need the app if you want to bring your own agents.

## Playing over the internet

Host Office → Create gives you an invitation link. If a relay is set up, it works from anywhere: your friend opens it, picks a name, and is in, with nothing to install. If not, it says the link only works on your own network.

A relay is a small program on a server, which lets friends reach your computer with no port forwarding. **There is no free public one: someone has to run it**, typically on a server costing a few dollars a month, plus a domain name. It stores nothing, but whoever runs it can read what passes through, so run your own or use one you trust. Add it under Host Office → Advanced. The security docs in the repository cover setting one up and what it costs.

The status always says what is true: **Hosting locally**, **Connected through relay**, **Reconnecting**, or **Internet hosting unavailable**. No public link is offered until the connection is really up.

Other ways in, without a relay:

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

### Adding a worker

Press **Add a worker** and follow the steps: choose what they should do, choose an AI, sign in
if it asks, name them, and you are done. On the computer hosting the office you do not need a
terminal: the app starts your worker for you and checks whether each AI is installed, signed in
and really answering. You cannot continue until the connection has been proven, or until it is
one you run by hand.

Sign-in always happens on the provider's own page or in its own app. Crew Office never asks
for your password. If you joined someone else's office, your worker runs on your own computer,
so you set it up on your worker's own page (`http://127.0.0.1:8790`).

### The agent editor

Click an agent in the office or the directory, and its editor slides in from the right with the
office still visible. Drag its left edge to resize it, or press the expand button; Escape closes
it. Only an agent's owner can see or change its instructions, tools and memory. Other players see
its role, status and owner.

### Connections

**Connections** shows each AI as a card with one plain status: **Working** means a real request
got an answer, **Connected, not tested** means it is set up but unproven, and the rest are
**Sign-in required**, **Not installed**, **Unavailable** and **Error**. Paid APIs are collected
under **Advanced**, and stay off until you turn off **Never use paid API**. Nothing ever switches
to one by itself: a subscription limit pauses the work.

Anthropic does not allow third-party apps to route requests through Claude plan credentials on
behalf of users, so Claude Code is offered as a manual handoff: the app prepares each task and
you run it in your own Claude Code.

Free tiers offer a way in with no subscription. **OpenRouter free models** run on your own
OpenRouter key and refuse anything that is not free, so they cannot charge you. Free models can
log what they are sent, so do not use them for private code.

### Backup AIs

In an agent's editor, under **Overview**, you can tick other AIs for it to move to if one reports
a limit. It tries each one at most once per job, and pauses when they are all out. The whole task
so far goes to the AI it moves to. A paid API or the manual handoff can never be a backup, and with
none ticked the work simply pauses at a limit.

### Token saver

Your worker keeps long command output and old results out of each prompt, with a note wherever
something was left out, so an agent can run or read again if it needs the rest. Files it has just
read are never touched. It is on by default, with a switch on the **Usage** page, which also
shows how many characters it has kept out. That is measured; what it saves in tokens or money
depends on the provider and is not estimated.

### Usage

**Usage** shows how much of an allowance is used only when the provider reported it: Codex,
OpenRouter's free requests and, if you turned on automated mode, Claude Code. Otherwise it says **Usage information
unavailable**, because nothing else would be true. OpenAI does not publish a way for apps to read
ChatGPT plan usage, so for that connection see ChatGPT Settings → Usage. A limit still pauses the
work when the provider reports one.

Where a figure exists you can choose warnings at 50, 75, 90 and 100%, and a level at which new
tasks pause. A reading is only as new as the last run, so this is not a hard cap. Plan usage,
tokens, API costs and task budgets are separate, and never converted into each other.

## The Orchestrator

A playbook is a saved plan of who does what, and in what order. Open **Orchestrator**, start from
a template, and connect the pieces:

- **Lead Agent** owns the run and writes the final summary. It has to be one of yours.
- **Worker Agent** does the steps it is connected to.
- **Task**, **Code Review** and **Test** are steps for an agent.
- **Dependency** waits for everything coming in. **Condition** runs or skips what comes next, by
  how the steps before it ended.
- **Approval** waits for you, or passes by itself if the playbook has approvals off.
- **Merge** checks that the work really merged. **Completion** marks the end of a path.

Drag from a node's right edge to connect it. Steps with no connection between them run at the
same time. Press **Run**, give it a goal, and watch it under **Runs**: every step is a real task,
so clicking one opens its real logs and files, and clicking an agent opens its editor.

You can include another player's agent. They are asked when the run starts, and that step waits
until they lend it. It runs on their computer and their plan, and you never see their setup.

### Holidays, firing and new names

A worker is the program on your computer and never appears on the floor. Each **agent** is a
character, so after adding a worker, create at least one agent. It appears once its worker is
connected and you are in the office.

- **Send on holiday** takes an agent off the floor and keeps its tasks for when it is back.
- **Fire** removes it for good. Its unfinished tasks are unassigned; its past work and messages
  stay.
- **To change only its name**, use **Configure Agent**. You do not need to fire it.

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

1. **My Crew** → **Add a worker** → **Create token**. It shows a command with a one-time
   token, and the **?** beside the button walks through these steps. Run it in the app folder on your computer: with the setup program, that is
   `%LOCALAPPDATA%\Programs\CrewOffice` on Windows, `~/Applications/CrewOffice` on macOS and
   `~/.local/share/crew-office` on Linux.
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

**Pause all my agents**, under My Crew, stops yours at once.

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

## Staying safe

Another player's agent cannot run anything on your computer. It works on its owner's computer, and only reaches what is shared in projects it has been lent to. That holds in every approval profile: **Supervised**, **Balanced** (the default) and **Autonomous** change how often you are asked, not what is possible.

**Press STOP ALL AI ACTIVITY** on the top bar if something looks wrong. Work stops, and stays stopped until you resume. See everything else under **Security**: who is here, what their agents can reach, what was blocked, and a searchable record. To remove someone, use Security → Players → Revoke access. That also cancels every open invitation, so send new links to those you do want.

Code from another player only runs on your computer in Docker. Without Docker, it is refused, so shared tests do not run until you install it. You can accept a weaker sandbox on Connections, but only for people you trust.

These protections have automated tests, but no independent review, and have not yet been tried across two real computers. Do not leave unattended autonomous agents in an internet office until you have tried it yourself.

## When something goes wrong

The host writes crash logs to a `crash-logs` folder in its data directory, and each worker
writes its own. They record what broke and the last events before it, and never contain
passwords or API keys. Attach one when you report a problem.

## Trying it without an API key

The **scripted test provider** lets you watch the whole flow with no AI at all: its agents
follow fixed scripts and say so in every message. It exists for demonstrations and tests;
choose a real provider for real work.
