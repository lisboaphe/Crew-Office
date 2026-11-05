# 9Router: compatibility and licensing assessment

Whether [9Router](https://github.com/decolua/9router) should be part of Crew Office, what it would risk, and what was built instead. Assessed on 2026-11-05 against its default branch (1,933 files) and each provider's own published terms. Terms change, so check them again before relying on this.

**The decision: 9Router is not integrated, and no code was taken from it.** Its licence allows reuse. The problem is what most of the useful code does. Four small original pieces give the same benefits by permitted routes: backup AIs, a token saver, a free tier with a real quota, and loop limits.

## Architecture

A Next.js app with a local proxy (`open-sse`) that exposes an OpenAI-compatible endpoint, translates between request formats, and switches between provider accounts when one runs out. Around that: 40+ provider adapters, OAuth flows, a usage dashboard, a token saver (`open-sse/rtk`), a certificate-installing interception proxy (`src/mitm`), tunnels and cloud sync.

## Licensing

| Part | Licence | Result |
| --- | --- | --- |
| 9Router | MIT | Compatible with this project's Apache-2.0. Reuse needs the copyright notice kept |
| `open-sse/rtk` filters | MIT, but they describe themselves as a port of [RTK](https://github.com/rtk-ai/rtk), which is Apache-2.0 | Provenance is not clean enough to copy without checking that RTK's notices were carried through. Written fresh instead |
| Provider client IDs and request shapes inside the adapters | Not the project's to license | Copying them would mean presenting this app as someone else's client, whatever the licence says |

The licence answers whether the code may be copied. It says nothing about whether a provider allows what the code does, which is where this was decided.

## What the providers allow

| Route in 9Router | What it does | What the provider says | Verdict |
| --- | --- | --- | --- |
| Claude Code OAuth | Takes a Claude plan sign-in into a third-party proxy and reads its usage with that token | Anthropic "does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users" | **Rejected** |
| Antigravity and Gemini CLI OAuth | Uses Google's sign-in from a third-party tool | Both sets of terms name this as a breach that "may be grounds for suspension or termination" of the account | **Rejected** |
| Codex OAuth and usage | Identifies itself as `codex_cli_rs`, and reads usage from an internal endpoint with the token | OpenAI offers Sign in with ChatGPT to apps instead, which this project already uses. Posing as another client is not that route | **Rejected.** The official route stays |
| `chatgpt-web`, `gemini-web` | Uses a pasted browser session cookie, and solves OpenAI's Sentinel and Turnstile bot checks | Extracts a session and defeats a bot check. OpenAI's terms page could not be fetched for this assessment, but no reading of a bot check makes solving it permitted | **Rejected** |
| `src/mitm` | Installs a root certificate, redirects DNS, intercepts Copilot, Cursor, Kiro and Antigravity traffic, and rewrites a host to a development endpoint to avoid rate limits | Circumvents limits on other companies' services, and weakens the machine's TLS trust | **Rejected** |
| Cursor, Copilot and other subscription routes | Same approach as above | Cursor's terms restrict reverse engineering. Copilot's terms for this use were not conclusively read | **Rejected**: nothing shows them to be permitted |
| Multi-account switching, "unlimited free" | Rotates accounts when a limit is reached | Evades limits rather than respecting them | **Rejected** |
| Cloud sync, tunnels | Copies credentials and settings off the computer, or exposes the proxy | Conflicts with keeping each player's credentials on their own computer | **Rejected** |
| Own API keys and local models | Standard, documented APIs | Permitted | Already supported here |
| OpenRouter free models | Own API key, documented API, documented free limit | Permitted. See below | **Added** |
| Fallback across chosen providers | Moves work when one reports a limit | Permitted between routes that are each permitted | **Added, with limits** |
| Compressing tool output | Local text processing | Nothing to permit | **Added** |

For a friend group the Google and Anthropic rows are not abstract: the consequence falls on each person's own account. The same goes for running 9Router separately and pointing a Local model connection at it, which this project does not stop, because that connection accepts any address. It is the owner's account and decision, and it is not a supported setup.

## What was built

All of it runs inside each player's existing worker, on their own computer. There is no new server, and the room host still never sees credentials or usage.

**Backup AIs** (`lib/crew-worker/router.cjs`). An owner can list AIs for an agent to move to when one reports a limit, under Agent editor → Overview. This is the routing that is permitted, and it has these limits:

- Only what the owner listed. An agent with no list behaves exactly as before: it pauses.
- Paid APIs and the manual handoff can never be on the list. The host refuses them, and the worker checks again, so a stale list cannot reach one.
- Only a provider's limit or sign-in problem moves the work. An ordinary error does not, because trying the next AI on a bad request would just spend more.
- Each AI is tried at most once per job, so it cannot loop. When all of them are out, the job pauses and says so.
- An AI that reported a limit is skipped for an hour by agents that have an alternative, so no request is spent on a known answer.

The task's whole context goes to the next AI, which is a real consequence of listing it. The editor says so.

**Token saver** (`lib/crew-worker/token-saver.cjs`). On by default, with a switch on the worker's page. It repeats nothing and hides nothing silently: colour codes go, repeated lines become one with a count, and very long command output keeps its start, its end and any line naming an error, with a note saying how many lines were left out. Older tool results in a long job are shortened with a note saying to read again if needed. Files an agent reads in the current step are never touched. The Usage page reports characters kept out of prompts, which is measured, rather than tokens or money, which would be guesses.

**OpenRouter free models** (`lib/crew-worker/providers.cjs`). A way for a friend with no subscription to bring a worker, on their own OpenRouter key. It cannot bill: the worker refuses any model that is not `openrouter/free` or ending in `:free`, and sends OpenRouter's documented `max_price` of zero as well. Its usage is the second real figure on the Usage page, read from the documented `GET /api/v1/key`. Free models can log prompts, and the card says so.

**Loop limits.** Already enforced before this work: a step limit, a time limit and a bounded number of task retries per job. Backup AIs add no new retry path.

## What this gives up

Compared with 9Router, this has far fewer free routes, no Claude or Google plan automation, and a shorter list of usage figures. Claude Code stays a manual handoff, and ChatGPT plan usage stays "unavailable". Each of those exists because the alternative risks someone's account. Usage figures in 9Router for Claude and Codex come from endpoints reached with a plan token, so showing them here would need the very thing being avoided.

Groq's free tier is a reasonable future addition, with documented rate-limit headers. It was left out because a Groq account on its paid plan would be billed, and unlike OpenRouter there is no model suffix or price cap to enforce that it cannot be.

## What was and was not tested

The router, token saver and free-model guard are tested with stand-ins for the providers (`test/crew-router.test.cjs`). Nothing here has been run against a real OpenRouter key or across real provider limits. Those need an account, and the first real run may show differences, particularly in how free models handle tools.
