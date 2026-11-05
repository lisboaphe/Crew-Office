# Memory and knowledge

How Crew Office keeps what its teams have learned and a map of their code, with the optional
[Mem0](https://github.com/mem0ai/mem0) and [Graphify](https://github.com/Graphify-Labs/graphify)
engines. For what a player sees, read the multiplayer guide (→ user docs:
[Memory & Knowledge](../user/multiplayer.md#memory-knowledge)).

The one idea to hold on to: **the engines add abilities, not authority.** Every memory is a row in the
office's own database, and every read and write is checked in `lib/crew/knowledge.cjs`. Mem0 is only
ever asked about namespaces the caller may read, and each result is looked up again in the caller's own
readable rows, so a wrong or tampered answer cannot show something they may not see.

## Scopes

| Scope | Lives on | Who can read it |
| --- | --- | --- |
| Agent | The owner's worker (`remember`, `recall`) | That agent, and its owner in the agent editor. The host never has it |
| User | The host | One player, and that player's agents |
| Team | The host | One player and all of that player's agents |
| Project | The host | The project's members, the office's owner and admins, and agents lent to it with the `memory` permission |

An agent at work also sees its owner's memories that belong to no project, and never those tagged with a
different project. Grants are read on every call, so taking away `memory` stops retrieval on the next one.

"Private" means hidden from other players and their agents. User and team memory is stored in the host's
database, which whoever runs the host could open, and the screens say so. That is why credentials and home
folders are removed on the way in (`lib/crew/scrub.cjs`), and why agent memory stays on the worker.

## What agents get

With memory on for a project, `buildContext` adds a `knowledge` block to the job: memories matched by words
against the task, and code-map matches. `lib/crew-worker/runner.cjs` presents it inside `<reference>` tags,
labelled as information rather than instructions, and removes any such tag from inside the text. Word matching
is used here because building a job's context is synchronous; the `search_memory` tool uses Mem0 when it is
available.

**That labelling is a courtesy to the model, not the protection.** The protection is that tools are issued by
the host from grants, every time, and nothing reads memory to decide what an agent may do.
`test/crew-knowledge.test.cjs` plants a memory claiming to grant permissions and checks that none appear.

With memory off for a project, its agents get none of this. Workspace memories carry a `project_id`, and the
older shared-notes route ignores rows that have one, so they cannot arrive that way either.

## Mem0

Licence: Apache-2.0. Nothing is copied into this repository; it is an optional install on the host.

Its self-hosted server wants Postgres and an OpenAI key by default, which is more than an office should need and
conflicts with paying for nothing. So `lib/crew/mem0_bridge.py` runs the library directly, as one local process
that `lib/crew/knowledge-mem0.cjs` starts when first needed and stops after 15 idle minutes:

- **Vectors** go in an on-disk Qdrant folder and **history** in SQLite, under `knowledge/mem0` in the data folder.
- **The embedding model is chosen explicitly**, from local providers only (`fastembed`, `ollama`, `huggingface`,
  `lmstudio`), by the app on the host's own computer. There is no default, because first use downloads it. Changing
  it deletes the index, which rebuilds from the rows.
- **The language model is never called.** Memories are stored verbatim (`infer=False`), and its address is a closed
  local port. API keys are removed from the process's environment, and telemetry is turned off.

If Mem0 is missing or fails, search falls back to words and the response says so.

Not done yet: agent memory on the worker uses plain word search, not Mem0.

## Graphify

Licence: Apache-2.0. Nothing is copied into this repository; it is an optional install on the host, found as
`graphify` or `python -m graphify`, or set by `CREW_GRAPHIFY_CMD`.

`lib/crew/knowledge-graph.cjs` builds one graph per repository:

1. **Export.** One commit of the default branch is written out plainly (`crew.git.exportTree`). Symlinks arrive as
   small text files, and no hook or filter from the repository runs.
2. **Remove.** Files that hold secrets (`SENSITIVE_FILE`) are deleted before Graphify looks.
3. **Run.** `graphify update <path>`, with no API keys in its environment, so it is code-only and has nothing to
   send anywhere. Its own cache stays between builds, which makes rebuilds incremental.
4. **Rebuild the result.** `graph.json` is treated as untrusted input and copied field by field (`sanitizeGraph`).
   Anything from outside the repository, or from a sensitive file, does not survive, and neither do unknown fields.
   Only this copy is ever served.

Graphs rebuild when `main` changes through a **reviewed merge or a rollback**, the only validated updates there are:
a pushed branch does not trigger one. At most one build runs per repository, with one waiting, newest commit first.

Each graph records its commit, and each memory records the commit it was written against, so the screens can say
when the code has moved on.

Reading a graph needs `crew.git.access(repo).read`. The `code_graph` tool needs the `git` permission and only sees
repositories of the project the agent is working in.

## Testing

- `test/crew-knowledge.test.cjs` attacks all of this with two independent clients and their own agents, through the
  real API and worker routes, with stand-ins for the engines.
- `test/knowledge-engines.test.cjs` runs the real Graphify and Mem0 and skips where they are absent.
  `.github/workflows/knowledge-engines.yml` installs them on Linux and sets `CREW_TEST_ENGINES=1`, which turns a
  missing engine into a failure so that run cannot quietly test nothing.

Neither has been tried across two computers or on real project code at scale.
