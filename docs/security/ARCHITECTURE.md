# Security architecture

```
 Player A's computer (host)                     Player B's computer
 ┌──────────────────────────────┐               ┌──────────────────────────┐
 │ Room server                  │   HTTP(S)     │ Browser                  │
 │  rooms, tasks, messages,     │◄──────────────┤                          │
 │  bare Git repos, shared files│               │ Worker                   │
 │  spawns only git and tar     │◄──────────────┤  B's sign-ins, B's vault │
 │                              │  worker token │  B's agents' clones      │
 │ Worker (A's, separate)       │               │  sandbox for their code  │
 └──────────────────────────────┘               └──────────────────────────┘
```

**Rule A holds by construction.** An agent's model calls and code run on its owner's worker. No route or tool runs a command on the host, so a cross-team task cannot become one. What crosses between computers is task assignments, messages, Git pushes and artifacts.

## Where each rule is enforced

| Rule | Enforcement | File |
|---|---|---|
| A: no general host access | No such route. Tools run where the catalog says, and host tools are a fixed list | `lib/crew/host-tools.cjs`, `catalog.cjs` |
| B: private files stay private | Paths confined to the project's folder. Project membership per request. Private agent memory is on the owner's worker | `lib/crew/work.cjs`, `api.cjs` (`projectAccess`), `lib/crew-worker/local-tools.cjs` |
| C: every request authorised | Session or worker token on every route. Permissions read from the database, never from the request | `lib/crew/api.cjs`, `rooms.cjs` |
| D: no unrestricted execution | The only path to running code is `sandbox.forContext` | `lib/crew-worker/sandbox.cjs` |
| E: credentials stay local | Held in the worker's vault. The host has no field for them | `lib/crew-worker/vault.cjs` |
| F: sharing is not execution | Nothing executes on push or upload. Files are served as `text/plain` with `nosniff` and no scripts allowed | `lib/crew/git.cjs`, `files.cjs`, `api.cjs` |
| G: boundaries cannot be disabled | Approval modes change whether a person is asked. No setting reaches the checks above | `lib/crew/policies.cjs` |

## Identity

Players are a name, a colour and a session cookie (HttpOnly, SameSite=Lax, Secure over HTTPS). State-changing requests also need `X-Crew: 1`, which a cross-origin page cannot send. The owner of the hosting computer is recognised by a key file passed to the app window, not by connecting from localhost, because the owner's agents are on localhost too. Workers use bearer tokens stored only as hashes.

Names are labels. Typing someone's name makes a new player. That also means a removed player can return under a new name if they have a working link, which is why removing a player revokes every open invitation.

## The worker's own page

It listens on loopback, checks `Host` on every request, and accepts cross-origin requests only from `localhost` and `127.0.0.1` pages. A remote office's page is refused, because that is code from someone else's computer. Non-browser programs on the same computer can still reach it: sandboxed code is prevented by the network guard, and other local programs are outside this threat model.

## What is not built

- **OS credential store.** The vault is AES-256-GCM with a key file protected by file permissions.
- **MCP and third-party tools.** The runner has no MCP client, so none of the MCP requirements apply yet. If it gains one, those controls have to come with it.
- **A separate storage process.** The room server itself has access to its whole user account's files, though no route exposes them.
- **Per-capability Git rules beyond branches.** Permissions are groups (`files.read`, `git`, `exec`), not the finer list in the brief.
