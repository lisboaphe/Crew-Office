# When something goes wrong

## Stop the AI

**STOP ALL AI ACTIVITY**, on the top bar and in the Security Center. The owner or an admin can press it; anyone else's button stops only their own agents.

The host then, immediately:

1. Refuses new jobs, tool calls, chats, playbook runs and Git pushes.
2. Cancels queued work, and marks open tasks blocked.
3. Tells every connected worker to kill its running sandboxes.
4. Records it in the audit log.

It stays stopped through a restart, until an owner or admin presses Resume. Stopped tasks can then be retried.

### What it cannot do instantly

| Situation | What happens |
|---|---|
| A sandboxed command | Killed within moments on a connected worker |
| A model request already in flight | Finishes, and its result is discarded at the next step. It cannot be recalled from the provider |
| A worker that is offline or unreachable | Cannot hear the stop. Every tool call it makes is refused, and it stops itself after about 90 seconds without the host, killing what it was running |
| A Claude Code manual handoff | Runs in your own terminal, under your control. Close it yourself |
| Damage already done | A stop prevents more. See below for recovering |

A worker's owner can also stop it locally, without any host: **STOP ALL AI ON THIS COMPUTER** on Connections or the worker's page. That survives restarting the worker. Or close the worker.

## Smaller stops

| To stop | Do this |
|---|---|
| One agent | Send on holiday, or Fire |
| One team (your own) | Pause all my agents, in My Crew |
| One project | `POST /api/crew/rooms/<room>/projects/<project>/stop`. **No button yet** |
| A player's access | Security → Players → Revoke access |
| The whole office, keeping everything | Stop, in the lobby |
| Hosting entirely | Close Crew Office |

## If an agent did something unexpected

1. Stop it, then read Security → Security record, filtered to blocked or by its name. Recent tool calls are also on its entry there.
2. Git: nothing reaches main without review. Roll back from a snapshot under Git / Sync if something did.
3. Files: versions are kept for uploads. Check the project's Office files.

## If a credential may have leaked

Crew Office never sends credentials to a host, so start with where the leak happened.

- **ChatGPT:** sign out on the worker's page, then revoke the app in your OpenAI account.
- **An API key:** revoke it with the provider, and turn "Never use paid API" back on.
- **A worker token:** revoke the worker in My Crew and add a new one.
- **A Git token:** removing the player revokes theirs.
- **The machine key** (`machine.key` in the crew data folder): delete it and restart. Anyone holding a copy also needs local access to use it.

## If someone unwanted is in an office

Security → Players → Revoke access. It cuts their session and workers, and revokes every open invitation, so send new links to those you do want. If the relay itself may be compromised, change its key and sessions are at risk: everyone should re-enter.

## Evidence

The audit log is in the crew database, and each entry is chained to the last. The Security Center says whether the chain checks out. Back up the data folder before changing anything. Entries are kept for 180 days. Crash logs are in `crash-logs` in the data folder.
