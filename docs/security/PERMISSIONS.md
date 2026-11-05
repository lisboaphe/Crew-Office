# Permissions

Deny by default, and enforced on the host at the API, Git, tool and worker boundaries. A hidden button protects nothing, so the routes check for themselves.

## People

| Role | May | May not |
|---|---|---|
| **Owner** | Everything below; delete the office; invite admins | Read other players' instructions, credentials or local files |
| **Admin** | Manage players and settings; emergency stop and resume; read any project | Remove the owner; change other players' agents |
| **Member** | Bring agents; create and join projects; chat | Manage invitations or players; stop the office; read projects they have not joined |
| **Guest** | Watch and chat | Bring agents or create projects |
| **Team owner** (any player, for their own agents) | Configure, pause, fire them; lend them to projects; approve cross-team assignments | Touch anyone else's agents |

A project's contents (tasks, files, notes, logs) are for its members and the office's owner and admins. Others in the room see that it exists, and its progress.

## Agents

An agent's permissions are the intersection of what its owner gave it and what its owner granted the project. Groups:

| Group | Unlocks |
|---|---|
| `messaging` | Messages and questions to agents on the same project |
| `files.read`, `files.write` | That project's shared files |
| `memory` | Shared project notes, and its own private memory on its worker |
| `delegate` | Creating subtasks, within the delegation list, depth limit of 5, and 300 tasks per project |
| `exec` | `run_command`, on its owner's worker, in the sandbox |
| `web` | `fetch_url`, public addresses only |
| `git` | Its project's repositories, and pushing only its own `agent/` branches |

Every tool call is checked on the host against what that job was issued. The model's opinion does not come into it.

## Approval profiles

These decide how often a person is asked. **They are not security boundaries.** Sandboxing, file limits, tool permissions, credential isolation, network restrictions and branch protection are the same in all three. New rooms start on **Balanced**.

| Asks before | Supervised | Balanced | Autonomous |
|---|---|---|---|
| Merging into protected main | yes | yes | no |
| Pushing a branch | yes | no | no |
| Running code in the sandbox | yes | no | no |
| Fetching a web page | yes | no | no |
| Creating a subtask | yes | no | no |
| Deleting a shared file | **always** | **always** | **always** |
| Rolling back main | **always** | **always** | **always** |

Cross-team assignments follow the lending owner's setting on the grant, whichever profile is on.

An approval names the action, target, agent and project, can be decided once, only by its approver, and counts as a no after 24 hours.

## Revoking

- **A player:** Security → Players → Revoke access. Cuts their session and workers, and revokes every open invitation. They are barred from this office.
- **An invitation:** Security → Open invitations.
- **An agent from a project:** the project's grants.
- **A worker:** My Crew → Revoke.
