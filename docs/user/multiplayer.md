# Multiplayer: host an office, bring your AI team

Crew Office turns the office into a shared, multiplayer workspace. One player hosts an
office on their computer (or on a server); friends join it; every player brings their own
team of AI employees; and the agents plan, talk to each other, write files, run tests and
review each other's work on shared projects — on the office floor, as it happens.

Every movement you see is caused by something an agent actually did: a character sits at
a desk when its task starts, walks to the bookshelf when it reads project notes, turns
amber when it is waiting for a human, and shows a speech bubble when it sends a message.

## Installing

On Windows, download **CrewOfficeSetup.exe** from the latest release on the project's
Releases page and double-click it. Nothing else is needed: no terminal and no commands. It
installs for your account only (no administrator rights), checks that Node.js is installed
and offers to install it, and adds a **Crew Office** shortcut to the Desktop and Start menu.
Double-click it and Crew Office opens in its own window. The first time, Windows asks whether
Node.js may use the network — allow private networks so friends at home can join. Uninstall
from Settings → Apps; your offices and keys are kept unless you choose to delete them.

The setup program is not code-signed, so Windows may show *"Windows protected your PC"*.
Press **More info**, then **Run anyway**.

If you downloaded the source code as a ZIP instead, unzip it and double-click **Install Crew
Office.cmd** in the unzipped folder. It does the same as the setup program, from those files.
There is no need to run any commands yourself, and a browser tab on `localhost` saying the
connection was refused just means the office is not running: start it from the **Crew
Office** shortcut.

The window is Microsoft Edge or Google Chrome running in app mode, with a profile of its own.
Without either one, Crew Office opens in your default browser and keeps a console window open
instead; closing that console stops the office.

New here? Press **📘 How it works** in the lobby or the office for a short tour.

## Updates

**Check for updates** is at the top of the lobby and the office, on the computer that hosts it, and
turns into **Update available** when a new build is out. Nothing installs until you press it. The app checks the
published build's checksum, replaces itself, and comes back within about a minute; your
offices, projects and sign-ins are kept. Everyone in the office is disconnected until then.
While it runs, the update window shows each step as it happens: downloading, with how much has
arrived, checking the download, installing and restarting, and then opens the new version.

Close any worker window first. A worker runs from the same folder, so while it is open the
update stops and tells you, leaving the app as it was. Updating inside the app is Windows
only for now; on macOS and Linux the button takes you to the download page.

If the app's repository is private, GitHub has to know it is you: press **Sign in to GitHub** and
finish in the window that opens, with an account that can see it. That needs the GitHub CLI
installed. If you cannot see the repository, ask whoever runs it for the new setup program.

To look for updates the app asks GitHub for the latest build, so GitHub sees that request
come from your address. Other players' copies are not involved: a player only needs the
host's address, and uses whatever the host runs.

## Hosting an office

1. Open Crew Office. Pick a name and a colour; that is all it asks, and this browser remembers
   you.
2. Press **Host Office**. Choose an office you already have, or name a new one, then who can join
   and how many players, and press **Host Office** again:
   - **Invitation only** — only people you send the invitation to. This is the default.
   - **Invitation, or room code and password** — a room code alone also asks for the password.
   - **Invitation, or anyone on my network** — also announced to computers on your own network.
3. Crew Office makes the office reachable and checks that it really is, from outside. When it
   says **Internet room available**, you get an invitation link and a short room code.
4. Press **Copy Invitation** and send it to your friends. It works for 72 hours and 20 people.
   Press **Revoke Invitation** to stop it working at once, and make a new one any time.
5. **Enter office**. The same screen shows who is connected. **Stop Hosting** closes the office to
   everyone and keeps everything in it.

If it says **Internet service unavailable** instead, it gives the reason and offers no link, because
it would not work. See [Playing over the internet](#playing-over-the-internet).

The office runs while the Crew Office window is open, and **closing the last window stops it**.
To keep one running without a window, use `npm run host` from a checkout, or a
[dedicated server](#playing-over-the-internet). Everything — players, agents, projects, tasks, messages
and files — is saved on the host and is still there after a restart. When you open it again, an
office you were hosting comes back online by itself, on the same link.

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

**If someone sent you an invitation link**, just open it in a browser. It shows the office and who
is hosting it. Pick a name and a colour and press **Join office**. You do not need to install
anything to join; you only need the app if you want to bring your own agents.

**With Crew Office installed**, press **Join Office** and either paste the link or enter the room
code, then press **Join**. If you click a `crewoffice://` link, the app opens and shows you which
office it is before you go in. On Windows and Linux the installer sets that up. On macOS, open the
ordinary link instead.

Room codes look like `ABCDE-FGHIJ`. Capitals, spaces and dashes do not matter. A code is
an invitation you can read aloud, so it stops working when the invitation does. If you and the host
are on the same network, Crew Office connects to them directly instead of over the internet.

**Recent Offices** takes you back to one you have been in. Under **Advanced settings** are offices
announced on your network, joining by a computer's address, and joining by an office's keycard.

## Playing over the internet

Friends need nothing but the invitation: no VPN, no router settings, no port forwarding, nothing to
install. Neither do you. Your office and its files stay on your computer.

**This needs a connectivity service to be running somewhere.** It is a small program on a server,
which carries traffic between your friends and your computer. Crew Office finds it by itself once
your copy has been built knowing its address. There is no free public one, so someone has to run
it, typically on a server costing a few dollars a month plus a domain name. Until then Host
Office says so, and you can add a relay under **Advanced settings**, or use one of the other ways
below. Instructions for running one are in the [developer docs on deploying the connectivity
service](../developer/connectivity-service.md) (→ developer docs).

The service stores nothing, but whoever runs it can read what passes through, so run your own or use
one you trust. Your AI sign-ins never pass through it. Git pushes and large files do, and they are
what uses its bandwidth.

The status always says what is true now:

| Status | What it means |
| --- | --- |
| **Hosting locally** | Only your own network can reach this office |
| **Connecting to internet service** | Connecting, and checking from outside |
| **Internet room available** | Checked from outside, and working. Only now is there a link |
| **Relay connection** | Your traffic is going through the service |
| **Direct connection** | You are connected over your own network, not through a service |
| **Reconnecting** | Lost the connection, and trying again. Friends come back by themselves |
| **Internet service unavailable** | It cannot work right now, and the reason is shown |

These have automated tests on one computer. They have not yet been tried between two real internet
connections, so try it with a friend before relying on it.

Other ways in, without a service:

| Option | What you do | Notes |
| --- | --- | --- |
| VPN mesh (Tailscale, ZeroTier) | Everyone installs it; friends use the host's VPN address | Private, and needs no server. Everyone has to install it |
| Port forwarding | Forward the host's port (8080) on your router; share your public IP | Exposes the host to the internet: use a strong room password, ideally HTTPS through a reverse proxy |
| A tunnel (Cloudflare Tunnel, ngrok) | Run the tunnel on the host; share its HTTPS address | No router changes. Live updates need one that supports streaming |
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
you run it in your own Claude Code. The worker's page lists each one under **Waiting for you**,
with the folder to work in and the brief. When you have written the result there, press **Done**.
A task whose office or project has since been deleted can never be finished, and **Done** says so;
press **Remove** to take it off the list. Its files stay where they are.

There is also an automated Claude Code mode, off unless you tick **Let this worker start my own
Claude Code automatically** on the worker's page after reading the notice beside it. Then choose
**Claude plan: automated Claude Code** as the agent's AI.

### Limited or autonomous

**Freedom**, in an agent's panel, says how freely it works.

- **Limited** is the office's way: the agent acts only through the office's own tools, and you
  choose which under **Skills & Tools**, from reading and writing files to running commands, using
  Git or fetching from the web. A new agent starts with all of them switched on, so it can do the
  work straight away. Switch off whatever you would rather it did not do.
- **Autonomous** is Claude Code working as itself, with its own tools, as it does when you run it
  yourself: reading, writing, running commands, unzipping, installing. It works in its project's
  folder, and what it makes comes back into the project when it finishes, where reviews, tests and
  approvals still apply. Claude Code keeps its file tools inside that folder. Commands it runs
  start there but are not fenced in on Windows.
- **Let it use the whole computer** goes further, for playing alone or with people you trust: it
  can then read, change and delete anything you can.

Only an agent on automated Claude Code can be autonomous. And the computer that runs the agent has
the last word: **Autonomous agents on this computer**, on the worker's page, is the most it allows
there, and an agent set to more gets that. Choosing Autonomous in the app on your own computer sets
both. From anywhere else, also allow it on that computer's worker page, which nobody else can do
for you.

**No agent changes the settings.** None of the office's tools can change a setting; an agent can
only ask you, through an approval. While an autonomous agent is working, the worker refuses any
change that would let agents do more, such as reaching further, paid APIs or starting Claude Code
by itself, whoever asks; turning things down always works. Every change to those settings is shown
to you as a notification. And if the worker's settings file is changed behind its back, the worker
notices when it starts, puts the safe settings back, and tells you. An agent allowed the whole
computer can do anything you can, so that switch is for playing alone or with people you trust.

### A project's files

**Projects → Office files** has everything a project made. **What the agents made** lists the files
its agents wrote; open one to read it. Below that are the files people uploaded. **Download all
(.zip)** gets the lot in one file, for anyone on the project and for the office's owner and admins.
On the computer hosting the office, the page also says where the agents' work is kept, and
**Open folder** opens it. Nobody else is ever shown the host's folders.

Agents read text, and they cannot open an upload themselves. So when you upload a **.zip**, the
office unpacks the text inside it, code, scripts, settings and documents, into the project's files,
in a folder named after the zip, where every agent on the project can read it. Images, fonts and
other binary files stay in the zip, and **UNPACKED.md** in that folder lists them. A zip uploaded
before this, or one you want unpacked afresh, has **Unpack for the agents** beside it.

### Where project files go

Each project's files on your computer are in a folder of its own, made the first time one of your
agents works on it: **Crew Office Projects** in your home folder, then the office, then the project.
Your agents' copies of its repository are in there, under **agents**, and so are the tasks handed
to you to run in Claude Code, under **handoffs**.

To clear away an old project, delete its folder. The office keeps the project's board, chat,
shared files and repository, so you lose only work your agents had not handed back yet. The
worker's page shows where the folder is.

### Screenshots

**Projects → Screenshots** shows what your coding agents saw while they worked: a game they are
building, a page they are changing, newest first, with who took each one and when. Click one to see
it full size. **Keep** marks the ones worth keeping, **Delete** removes one from your computer, and
**Delete all not kept** clears the rest in one go. New ones turn up on their own within a few seconds.

They come from one folder on the computer hosting the office, and they stay there. Nothing in it is
shared with the office, sent to the other players or uploaded anywhere, and only you see this page,
on that computer.

- **Claude Code** puts the screenshots it takes there by itself, once its plugin is installed and the
  office is running. To stop that, set `ROVING_OFFICE_SCREENSHOTS=0`, or add `"screenshots": "off"`
  to `settings.json` in the `.roving-office` folder in your home folder.
- **Codex, or any other agent**, saves a screenshot there when you ask it to. **How screenshots get
  here**, at the bottom of the page, shows the folder with a **Copy** button. Paste it into your
  request, or into the project's instructions for agents, for example: *save a screenshot of the game
  into this folder after each change*. A file name that starts with `codex-` is labelled as Codex's.

PNG, JPEG, WebP and GIF images are shown.

Connections groups everything by what it costs you:

- **My subscriptions**: ChatGPT, Codex, Claude Code and Kiro, on your own plan.
- **Free and developer AI**: Cloudflare Workers AI, Google Gemini, Mistral, OpenRouter's free models,
  NVIDIA NIM's developer access and OpenCode's free models.
- **Other cloud providers**: Z.ai and Ollama Cloud.
- **Local AI**: Ollama and LM Studio, on this computer.
- **Advanced: paid APIs**: off unless you turn them on.

Each card opens the service's own page and walks you through getting a key. Keys are encrypted on your
computer, and go only to that service. Every player connects their own, and the office host never
receives them.

**Nothing runs until it is established that it will not charge you.** Some services use one key for
free and paid use, and will not tell the app which yours is. Those say **Verification required**:
look at your own account, then confirm what you found. If that later changes, for example if you link
billing to a Google project, remove your confirmation under **Configure**. Where a service has free
and paid models, only the free ones can be chosen. When a free allowance runs out, the work pauses,
or moves to a backup you ticked. It never moves to something that costs money.

Press **Models** to see each model and what the service says about it, and choose one. Agents can each
use a different one. Anything a service does not report says **Not reported**.

Free models can log or learn from what they are sent, so do not use them for private code. Each card
says what is known for that service.

### Talking to a project's agents

Each project has its own channel in the chat, and you can talk to its agents there the way you
would to an AI assistant. Write normally and the project's lead answers; write **@Name**, or
several, and those agents answer. Everyone in the channel sees the conversation, and the agents see
it too, with who said what.

Only your own agents answer you straight away, since an answer runs on its owner's plan. Another
player's agent you name gets your message in its inbox and reads it the next time it works; the
chat says so when you send it. Agents never start answering each other, so a conversation only goes
on while people take part. To talk to one of your agents alone, use **Chat** in its panel.

**What an agent can do in chat** is what you switched on in its **Skills & Tools**, nothing more
to set. In a project's channel it can save files, hand out work, run commands and fetch pages, as
it would on a task. In a private chat, ask it for real work ("build an MT5 bot and backtest it")
and an agent with **Create subtasks** switched on starts a project for it: it manages it, your
other agents join, and it plans the work. As with any project, when every task goes to your own agents the plan goes straight out, and you
only approve it yourself when your approvals are set to manual or someone else's agent is on it.

### Is an agent's AI working?

A small light in front of every agent's name, on the floor, in the agent list and in its panel,
says whether the AI behind it can work right now. Point at it to see why.

- **Green**: working. An agent's task got an answer from it, or **Test Connection** did.
- **Amber**: not proven yet, as no task or test has used it, or it is the manual Claude Code route,
  which waits for its owner to run each task.
- **Red**: it cannot work, and the light says why: signed out, a plan's usage limit reached, not
  installed, or no key.
- **Grey**: its owner's worker is not running, or the agent is on holiday.

Everyone in the office sees the lights, so players know whose agents can take work. A light says
only working or not and why, never anything about the owner's account. When an AI one of your
agents runs on stops working, you get a notification saying which agents and what to do, once,
until you have read it.

### Backup AIs

In an agent's editor, under **Overview**, the AI behind the agent and its model are saved the
moment you choose them, and so are its backup AIs. You can tick other AIs for it to move to if one
reports a limit. It tries each one at most once per job, and pauses when they are all out. The whole task
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

## Getting around

The dock on the left edge of the office is the menu. Rest the mouse on it and it opens, then it stays open until you
click somewhere else, press Esc, or choose a destination. With a keyboard, Tab to the dock and press Enter, then use the
arrow keys. Chat stays on the right, and the office stays visible behind everything.

Preferences has the appearance, animation and quiet-mode choices, and whether the lobby's hanging lamp sways and
flickers. Out of the box the lamp follows your system: with reduced motion turned on, as it is when Windows'
**Animation effects** are off, it hangs still and stays lit. Click the bulb in the lobby to switch it either way.

## Memory & Knowledge

This is what your team has learned, and a map of your code. Find it under **AI Management → Memory & Knowledge**.

**Who can see a memory** is chosen when you write it:

- **Only me:** you, and your own agents when they work for you.
- **My team:** you and all your agents.
- **The project:** everyone on the project, and agents lent to it with the memory permission.

Each agent also has its own private memory, which stays on its owner's computer and shows in the agent editor.

Other players and their agents cannot see your private or team memories. They are still stored on the computer hosting
the office, and whoever runs that computer could read that file. Do not save passwords or keys here. Things that look
like them are removed when you save, but a pattern can miss one.

**Switching it on:** under *What is on, per project*, a project can have **Memory for agents** and **Code graph**, each on
or off, both off to begin with. Only the project's creator, or the office's owner or an admin, can change these.

- With memory on, agents on that project get relevant memories before they start, and can search and add to them.
- With the code graph on, you get an interactive map of the project's code. Click anything to see what it uses and what
  uses it, and agents can look things up in it. It is rebuilt from what has been merged into `main`, never from unreviewed
  work, and it says which version it was built from.

Anything an agent reads from here is treated as information. It cannot change what the agent is allowed to do, even if
someone writes that it can.

### The optional plugins

Memory works with nothing extra, and search matches words. Both plugins below are free, run on the computer hosting the
office, and use no paid service. Neither is included in the download, because they need Python. **Settings → Plugins**
shows what it found on this computer.

- **Mem0** finds memories by meaning. Install Python 3.10 or newer, then `python -m pip install mem0ai fastembed` (on
  Windows, `py -m pip install mem0ai fastembed`), press Check again, and choose a local embedding model such as
  `BAAI/bge-small-en-v1.5`. The first use downloads that model.
- **Graphify** builds the code graph. Install it with `python -m pip install graphifyy` (on Windows, `py -m pip install
  graphifyy`) and press Check again. It only reads code, with no AI model, so nothing leaves the computer.

## The Orchestrator

A playbook is a saved plan of who does what, and in what order. Open **Orchestrator**, start from
a template, and connect the pieces:

The first time you open it, a guided tour points at each real control while you try it. **How it works** on that page starts it again, and it can open a template as a draft to follow along with.

- **Lead Agent** owns the run and writes the final summary. It has to be one of yours.
- **Worker Agent** does the steps it is connected to.
- **Task**, **Code Review** and **Test** are steps for an agent.
- **Dependency** waits for everything coming in. **Condition** runs or skips what comes next, by
  how the steps before it ended.
- **Approval** waits for you, or passes by itself if the playbook has approvals off.
- **Merge** checks that the work really merged. **Completion** marks the end of a path.

To take a step out, select it and press **Remove step** in the panel beside the canvas, or the
Delete key. Removing a step removes its connections too; to remove only a connection, click the
line and press **Remove connection**. Nothing is gone for good until you press **Save**.

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

1. **New project**: a name, a goal, and one of your agents as the manager. All of your agents
   are on it from the start, and an agent you add later joins your projects that are still
   going, so the manager can plan for the whole team straight away.
2. **Lend my agents** is for bringing agents to *someone else's* project, and for setting how
   much yours may spend here and whether work other players give them needs your approval.
   Other players join the project and lend their own agents. On your own project your agents
   use whatever is switched on in their own panels. When you lend to someone else's project you can also
   narrow which permissions they may use there. Lend everything, and a permission you switch
   on later works there too.
3. **Start**. The manager writes a plan of tasks, each assigned to the best-suited agent.
4. If every task is for your own agents, the plan goes straight out and they start. Otherwise
   you approve the plan, and each player approves work assigned to their agents. With your
   approvals set to manual, you always approve it first.
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
