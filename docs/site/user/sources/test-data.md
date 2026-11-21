# Test Data

*The simulation, and the default. Nothing to install.*

A fresh office opens onto a busy room with nothing installed, nothing running and no
adapter configured — because **a room with nobody in it is indistinguishable from a room
that is broken.**

It is also how everything visual gets checked.

## What a simulated shift looks like

| | |
|---|---|
| **arrive** | come in through the break room's door, the first time you see them |
| **intake** | a request lands addressed to them |
| **look up** | sometimes: researching what the company or the web knows |
| **wait** | sometimes: blocked on you |
| **fail** | occasionally: the work ends in an error, and that is the end of it |
| **deliver** | the finished work is delivered |
| **break** | a drink or a sit down, then the next request |
| **clock off** | after a handful of requests, they leave |

Roughly, per request: half involve a look-up, a fifth a wait, an eighth fail, and a fifth
arrive unaddressed.

**Requests drive it.** A request goes to somebody who is *free*, and what they spend the
next minute on is whatever it asked for.

## The room fills and empties like a real one

The headcount is the shape of a day rather than a number. The office **opens with its
regulars**, fills up **slowly** over the next couple of minutes as the extras drift in,
and from then on **wanders between the two**: somebody's shift ends, and a while later
somebody else turns up.

Everyone walks in with a shift of two to four requests and leaves when it is done — unless
they are one of the regulars holding the room, in which case the shift quietly extends.
**An office that empties reads as one that is broken**, which is the whole reason this
source exists.

In a five-desk office opening with three, that works out at roughly a fifth of the hour at
three people, half at four, a third at five, and never fewer than three.

## They are named the way real sessions are

Simulated agents used to draw from a short playful pool — `Rovo`, `Pixel`, `Vex`. They now
go through [exactly the same naming as a live session](../agent-names.md),
so `Fix the flaky checkout test` makes somebody `Flaky-Mender`.

Nothing is lost in telling them apart, because the name was never the honest signal: every
agent wears the mark of the source it arrived on, and the badge says
`Test Data · simulated`.

## Pressing T

**T** posts a request by hand, addressed to whoever is free — or unaddressed into the box
if nobody is. It **deliberately ignores whether anybody is free**: somebody asking for work
by hand has already judged that for themselves, and a keypress that quietly declined would
just look broken.

Keep Test Data ticked alongside a live feed and **T** stays available, which is genuinely
useful while you are still getting an adapter working.

## Handy for a second office

Nothing about Test Data needs the receiver. Only one office on a machine can be the one
your adapters feed, so a second one serves the page but gets no events — point that one at
Test Data and it behaves perfectly.

## Read next

- [Connect your agents](../connect-your-agents.md) — swapping this for your real sessions
- [Watching the office](../watching.md) — how to read what you are now looking at
