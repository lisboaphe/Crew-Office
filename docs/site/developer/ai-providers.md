# AI providers

How an agent reaches a model on its owner's computer, what each service documents, and how far each
integration has really been proven. The room host hears a connection's state and one line of reason,
never a key or an account fact.

## The shape of it

| File | What it holds |
|---|---|
| `lib/crew-worker/ai-connections.cjs` | Each service: setup steps, how to list models, and the rule for what may run |
| `lib/crew-worker/providers.cjs` | `createProvider`, the one place every model call passes through, and `gated`, which applies the rule to each request |
| `lib/crew-worker/cli-providers.cjs` | The official CLIs used as a plain model: Claude Code, Codex, OpenCode, Kiro |
| `lib/crew-worker/os-secret.cjs` | Holds the vault's key in the operating system's own store |
| `crew/connections.js`, `crew/wizard.js` | The Connections screen and the Add Worker wizard, talking straight to the worker on this computer |
| `lib/crew/catalog.cjs` | What the host may know of each service. No account facts |

To add a service, add an entry to `DEFS` and one to `PROVIDERS`. An OpenAI-compatible one needs no
code of its own.

## The rule

Whether a request costs money is decided **per model**, in `block()`, before anything is sent:

| Class | Runs when |
|---|---|
| `free`, `promo`, `subscription`, `local` | Established, as below |
| `trial` | The owner has agreed to trial use |
| `unknown` | Never. The owner has to check their own account first |
| `paid` | "Never use paid API" is off **and** paid models are allowed on this connection |

Several services use one key for free and paid use and do not tell an app which applies, so they
start as `unknown`. Nothing here infers free from a service's marketing. A confirmation is recorded
with its date, and is the owner's statement, not something this app verified.

A provider that reports a limit (429, or 402 for an empty balance) pauses the job or moves it to a
backup its owner listed, at most once each, per `router.cjs`. A backup that cannot run for billing
reasons is skipped. Test Connection goes through the same rule, so it cannot be how a charge happens.

## What each service documents

Read from each service's own documentation on 5 November 2026. Limits and free lists change, so the
code asks the service wherever it can, and treats these as a starting point.

| Service | Reached through | Models from | What decides the cost |
|---|---|---|---|
| Cloudflare Workers AI | `api.cloudflare.com/client/v4/accounts/{id}/ai/v1` | `/ai/models/search` | Workers Free fails with an error past 10,000 Neurons a day. Workers Paid bills past it. An app cannot tell which |
| Google Gemini | `generativelanguage.googleapis.com/v1beta/openai` | `/v1beta/models` | A key takes its project's tier. With no billing account linked it stays free. An app cannot tell |
| Mistral AI | `api.mistral.ai/v1` | `/v1/models`, with `capabilities` | Experiment plan is free. The same key works on paid plans |
| OpenRouter | `openrouter.ai/api/v1` | `/models`, with `pricing` | Per model. Only zero-priced models are offered, and the request also carries a price cap of zero |
| NVIDIA NIM | `integrate.api.nvidia.com/v1` | `/v1/models` | Developer trial. The figures are from NVIDIA's forums, not its terms, so none is shown |
| Z.ai | `api.z.ai/api/paas/v4` | `/models`, or the pricing page if that fails | `glm-4.7-flash` and `glm-4.5-flash` are free. The rest bill the account |
| Ollama Cloud | `ollama.com/v1` | `ollama.com/api/tags` | The $0 plan is pay per token for cloud models. Any plan draws on purchased credit after its included usage |
| OpenCode | `opencode run` | `opencode models opencode --verbose`, with `cost` | Per model. Free models need OpenCode itself, and are free for a limited time |
| Kiro | `kiro-cli chat --no-interactive` | `kiro-cli chat --list-models --format json` | Credits on the owner's plan. API keys come from paid plans only |

### OpenCode and Kiro as plain models

Like Claude Code and Codex, these are agents in their own right, so they run in an empty folder with
their own tools off, and the office's tools are offered through a small JSON protocol. That keeps
permissions, approvals, budgets and the sandbox exactly as they are for everything else.

Three things about OpenCode took finding out, and the code depends on them:

- **A rule denying everything hangs a run**, with no output. One file has to stay readable by name.
- **A prompt sent as an attached file gets refused**, because a careful model takes it for a prompt
  injection. So it is a custom agent's system prompt.
- **It believes `PWD` over its real working folder**, so a shell that leaves a stale one breaks it.

It also reports what each step cost. Anything above zero stops the connection.

### 9Router

Not used. `9router-assessment.md` has the reasoning. A routing layer could choose a paid model where
this rule cannot see it, and direct connections turned out to be enough. Someone can still point the
Local connection at one, and it would then count as local, so that is theirs to judge.

## How far each is proven

**Fully functional and tested** means a real agent did a real task through the real service. Nothing
else earns it. `test/crew-ai-providers.test.cjs` runs against a stand-in server: it proves what this
app sends and refuses, not that a service behaves as documented. `test/live-ai-providers.cjs` talks to
the real ones, by hand, with the owner's own key.

| Service | Status | What was run | What is missing |
|---|---|---|---|
| OpenCode | **Fully functional and tested** | Installed, models listed, Test Connection, wizard, a real project planned and a file written, cancel, tools denied | Only on Windows |
| OpenRouter | Partially functional | Real model list. Request flow against the stand-in | A real key |
| NVIDIA NIM | Partially functional | Real model list. Request flow against the stand-in | A real key |
| Ollama Cloud | Partially functional | Real model list. Request flow against the stand-in | A key, and a plan confirmed by its owner |
| Z.ai | Partially functional | Free list from its pricing page. Request flow against the stand-in. Its model list has not been seen | A real key. Coding Plan keys use another address, which is not offered |
| Cloudflare Workers AI | Partially functional | Request flow against the stand-in. Model list parsed from the documented shape, not seen | A real token. Whether tool support is reported as assumed |
| Google Gemini | Partially functional | The same | A real key |
| Mistral AI | Partially functional | The same | A real key |
| Kiro | Not proven | Written from its documentation. Never run | The CLI and a real account. Its docs do not say whether a sign-in alone runs without a person, or give a Windows install command |

### What no service here does yet

- **Streaming.** Replies arrive whole. Where a service documents streaming the model list says so,
  which is about the service, not this app.
- **Reading a balance.** Usage shows what this worker counted and what a service stated in its reply
  headers. Otherwise it says Usage unavailable.
- **Search tools for researchers.** `fetch_url` works with any model. No service's own search is wired up.

## Keys

Encrypted with AES-256-GCM. The key to that is held by Windows DPAPI, the macOS Keychain or the
Secret Service, whichever the system has, and otherwise a user-only file. The Connections screen says
which. An older key file moves across and is removed only after the store gives the same key back.
DPAPI is tested. **The macOS and Linux paths have never run.** On Windows this is DPAPI directly, not
an entry in Credential Manager, though the protection is the same kind.

A key goes to its own service and nowhere else, and any echoed in an error is replaced before it can
reach a log. The CLIs run with every other service's keys removed from their environment. Base
addresses are fixed in code. The `CREW_AI_BASE_*` overrides exist for tests, and only the owner of the
computer can set them.

## Updates and a private repository

GitHub answers an anonymous request for a private repository as it would a missing one. So
`lib/crew/update.cjs` asks anonymously first, and on a refusal asks again with the person's own sign-in:
`gh auth token`, then `git credential fill`. Neither is stored, and neither reaches a browser. Downloads
use the asset API address, because the plain download link does not accept a token. Whoever installs
needs an account that can see the repository. A friend without that cannot update in the app, and
should be sent the setup program, unless the repository becomes public.

Each build is published by `.github/workflows/release.yml` on a push to `main`, and uses GitHub Actions
minutes from the account that owns the repository.
