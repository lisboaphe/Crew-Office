# The jobs system

*What the office thinks work is, and why it needed its own word for it.*

This is the conceptual document. It assumes no knowledge of the code and names very
little of it; if you want the wire format go to [the AOP spec](../developer/protocol/aop-spec.md), and if you
want the delivery machinery go to [job delivery](../developer/job-delivery.md).

---

## 1. One idea

**A job is one unit of work, with a name, a beginning, an end, and an outcome.**

That is the whole of it. Everything else in this document is either a consequence of
that sentence or an argument about why it had to be said at all.

A job is what the "Recent jobs" list remembers. It is what arrives for an agent, keeps
them at their desk, and ends either delivered or in an error. When you look at the office and ask *what is that person doing*, the answer is
the name of a job.

---

## 2. Why the office needed a word of its own

The office watches agents working in other programs — Claude Code, Cursor, Codex, Rovo,
OpenClaw and whatever comes next. Each of those programs already has words for what an
agent is doing. The trouble is that they are **different words for different shapes**,
and none of them is the shape a room can be drawn from.

One harness has *turns*: a prompt goes in, an answer comes out. Another has *tasks* in
the sense of a spawned subagent — a Task tool call, which is a completely different
animal. Another keeps a *todo list* the model writes for itself and ticks off as it
goes. Another runs on a schedule and has no prompt at all. Several have all of these at
once, and mean something slightly different by each.

If the office adopted any one of those vocabularies it would inherit that harness's
idea of work and misrepresent everybody else's. If it adopted all of them it would have
no idea of work at all — just a passthrough with furniture.

So the office defines one concept, in its own words, and every adapter's job is to
answer one question: **what unit of work does this correspond to?** Whatever the harness
calls it, if it has a name and it starts and finishes, it becomes a job.

> **Why "job" and not "task"?** A job is what a printer does, what a queue holds, and
> what somebody hands you. A task is what a to-do list holds — and several harnesses use
> "task" for something specific and much smaller (a spawned subagent), so the word was
> already taken twice over. The office called it a task until it got confusing enough to
> fix.

---

## 3. What maps to a job, and what does not

The distinctions matter more than the mapping, so here is what a job **is not**:

| Not a job | What it is instead | Why the difference matters |
| --- | --- | --- |
| A **session** | One conversation in a harness — one *character* in the office | A person is not their current job. They arrive, do several, and go home. |
| A **tool call** | One action — a file read, a command, a search | It moves the character to a prop. Dozens happen inside one job. |
| A **step** | One part of a job — see §5 | It changes the label, not the log. Finishing a step is not finishing work. |
| A **subagent** | Another session, with a parent | It has its own jobs. The room does not draw these yet, so a fan-out looks like one busy person. |

And here is what does become a job, whatever it was called at the other end:

- A **prompt and its answer**. The commonest case by far: you ask for something, the
  agent works, it stops. One job.
- A **scheduled run**. No prompt, no human, but a name and a beginning and an end — so
  it is a job like any other. It just says on the record that a clock started it rather
  than a person.
- A **queued request** the office received itself. Work can arrive addressed to the
  office rather than reported by a harness (§4).

The office deliberately does **not** re-summarise. A job's name is the first line of
whatever the prompt or the harness gave it, cleaned up a little and capped at a length
that fits on a desk. It never asks a model what the work "really" was. A label you did
not write is a label you cannot trust, and the office would rather show you eighty
honest characters than an invented sentence.

---

## 4. A job's life

The office shows where a job is by showing the agent doing it.

```
     arrives               worked on                    ends
   ┌────────────┐       ┌────────────────┐       ┌──────────────┐
   │ addressed  │ ────► │ at the desk,   │ ──┬─► │  delivered   │  done
   │ to an agent│       │ typing         │   │   └──────────────┘
   └────────────┘       └────────────────┘   └─► ┌──────────────┐
                                                 │    error     │  failed
                                                 └──────────────┘
```

1. **It arrives.** A request reaches an agent: one somebody typed to it, or one handed out
   to whoever is free.
2. **It is worked on.** The agent sits at their desk and types, with their program on the
   screen. Somebody on a break comes straight back for it.
3. **It ends, one of two ways.** Finished work is delivered; failed work ends in an error,
   and the agent shows a small red mark. Either way the job closes with an outcome, and the
   log keeps it.

The last step is the one worth dwelling on. **A job always ends with an outcome you can
find.** There is no quiet disappearance: if work fails at three in the morning, the error
and the log entry are still there when somebody looks in the morning.

---

## 5. Steps: what a job is made of

A job is often not one motion. "Fix the parser" might be six things, and modern agents
increasingly *say* what those things are — they write themselves a checklist and tick it
off.

So a job may carry a **plan**: an ordered list of parts, each with a name and a state.
While a job is in flight, the room can show which part is in hand.

The rule that keeps this honest: **a step changes the label, not the log.** Steps are
what the work is called *right now*; the job is what it will be remembered as. Ticking
off "run the tests" does not finish anything, does not post anything, and does not
appear in the history. Only the job does.

This is also why steps are optional. A harness that reports a flat prompt-to-answer
cycle produces a perfectly good job with no plan in it. One that reports a todo list
produces the same job with more to look at. Neither is more correct, and the office does
not invent a plan for a harness that has none.

---

## 6. Why a room at all

A dashboard could show the same facts in less space. The room earns its keep in three
ways, and all three are about **jobs having somewhere to be**.

**A job's state has a place.** Not only a status field: somebody at a desk. Typing is work
in flight, and a red mark is work that failed. You read the system by looking at it, and
you notice the wrong thing without being told to look for it.

**Concurrency is legible.** Five agents working is five people at five desks — which no
list of rows manages. (One agent spawning five subagents is *meant* to be five ghosts
crowded round one desk. That part is designed and not yet drawn.)

**Time is visible.** A job that has been open for an hour is somebody who has been
sitting there for an hour. Duration is not a column you have to sort by; it is a person
you keep noticing.

The cost is honesty about scale. This is a room, so it holds a roomful — a dozen or so
desks. It is a way to watch a team work, not a way to observe a fleet.

---

## 7. What this buys

Because a job is one concept rather than five vocabularies:

- **Any harness can be added by answering one question.** What is a unit of work here?
  Everything else — the desks, the log, the labels — already exists.
- **Different harnesses are comparable.** Two agents at two desks are doing the same
  kind of thing, even though one is driven by a prompt and the other by a schedule.
- **The record outlives the run.** A job log entry is a name and an outcome, which
  survives the session that produced it going away.

## Where to go next

| For | Read |
| --- | --- |
| The wire format that carries all this | [aop-spec.md](../developer/protocol/aop-spec.md) |
| How each harness's events become jobs | [aop-harness-adapters.md](../developer/protocol/aop-harness-adapters.md) |
| The post, the outbox and the bin in detail | [job-delivery.md](../developer/job-delivery.md) |
| What is in the office, and what people do there | [the room](the-room.md) |
