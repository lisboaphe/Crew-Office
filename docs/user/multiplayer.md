# Multiplayer: host an office, bring your AI team

Crew Office turns the office into a shared, multiplayer workspace. One player hosts an
office on their computer (or on a server); friends join it; every player brings their own
team of AI employees; and the agents plan, talk to each other, write files, run tests and
review each other's work on shared projects — on the office floor, as it happens.

Every movement you see is caused by something an agent actually did: a character sits at
a desk when its task starts, walks to the bookshelf when it reads project notes, turns
amber when it is waiting for a human, and shows a speech bubble when it sends a message.

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
instructions (only you can read them), a model provider and model, a budget, permissions,
and an autonomy setting ("act within its permissions", or "ask me before writing files,
running code or fetching").

Only you can configure, pause, resume or remove your agents. The office owner cannot.

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
