# Progress

What is still to do on Crew Office, as of 21 November 2026, with build 38 the latest release.
Issues and pull requests are the record of the work itself. This page collects what is open
in one place, including what lives only on the owner's computer.

## Waiting on a decision

- **Merge the open pull requests that are ready.**
  [#81](https://github.com/lisboaphe/Crew-Office/pull/81) installs on Omarchy and Arch Linux,
  and makes a Linux build write a real zip. [#70](https://github.com/lisboaphe/Crew-Office/pull/70)
  takes the original project's front page out of the README. Each merge publishes a build.
- **Rework or close the two pull requests that conflict with `main`.**
  [#13](https://github.com/lisboaphe/Crew-Office/pull/13) lets the app update itself on Linux,
  and [#79](https://github.com/lisboaphe/Crew-Office/pull/79) adds a live screenshot card.
- **Close the issues the 2D office already covers.**
  [#14](https://github.com/lisboaphe/Crew-Office/issues/14) (2D preview),
  [#15](https://github.com/lisboaphe/Crew-Office/issues/15) (colours and logo) and
  [#16](https://github.com/lisboaphe/Crew-Office/issues/16) (oak floor) were done by the 2D office
  instead. Their worktrees still hold old drafts of the 3D approach, never committed.
- **Security reports have nowhere to go.** `SECURITY.md` points at GitHub's private
  vulnerability reporting, which is switched off for this repository. Either switch it on in
  Settings → Security, or give `SECURITY.md` another way to reach the owner.
- **A contact for commercial use.** `LICENSING.md` asks anyone who wants to use Crew Office
  commercially to ask "through this repository". Add a direct contact if that is wanted.
- **The `v1.0.0-beta` tag is out of date.** It points at commit `3f69367`, before the licence
  change and everything since, and the version is now `1.0.0-beta.1`. Move it, add a new tag,
  or drop tags in favour of the numbered builds.
- **The website and domain.** The deploy workflow only runs when the `DEPLOY_TO_FLY` variable is
  set, and it is not, so `therovingoffice.com` is the original project's site. `fly.toml` still
  names the original app, and the docs still link to its demo office. Decide whether Crew Office
  has a site of its own, and change or remove those.

## Work to do

- **Agents resend the whole project on every turn.**
  [#65](https://github.com/lisboaphe/Crew-Office/issues/65): costly in tokens.
- **The README and the repository description.**
  [#69](https://github.com/lisboaphe/Crew-Office/issues/69), partly done by
  [#70](https://github.com/lisboaphe/Crew-Office/pull/70).
- **A live screenshot card.** [#77](https://github.com/lisboaphe/Crew-Office/issues/77), with its
  pull request #79 in conflict.
- **Updating inside the app on Linux.** [#12](https://github.com/lisboaphe/Crew-Office/issues/12),
  with its pull request #13 in conflict.
- **12 agents, or 20.** The server lets a player bring at most 12 agents into an office
  (`lib/crew/agents.cjs`), while the office has room for 20 each. Raise the limit, or lay out
  for 12.
- **The last hand-drawn art.** The window, the wall clock and the wall pictures are still
  drawn by `finish-established-art.lua` rather than cut from the reference sheets.
- **The player walking in.** Agents come in through the break room's door. The player starts
  at their desk.
- **Eight files still show "Import The Roving Office" on GitHub**, as nothing has changed them
  since: `.npmrc`, `CLAUDE.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, `eleventy.config.mjs`,
  `fly.toml`, `hooks` and `program.md`. `LICENSE` has to stay as it is.
- **Development tools have known vulnerabilities.** `npm audit` finds 5, 2 of them high, in
  ESLint and the documentation build. None of them ships: the app's own dependencies have
  none. Updates are available for all five.
- **GitHub's security scanning is off.** Dependabot alerts, secret scanning and code scanning
  are all switched off.

## Not tested

- Multiplayer between two computers, in the 2D office.
- The Windows and macOS installs of the 2D office.
- The 2D office on a phone.
- The Omarchy installer on a clean system.
- Walking through the door between rooms stacked one behind the other, seen on screen. Tests
  cover the routes.

## On the owner's computer only

- **The reference sheets** the office art is cut from are not in this repository. The only
  copy found is in a Codex worktree, `~/.codex/worktrees/office-pixel-art/Crew-Office/assets/pixel-art`,
  about 33 MB. Back them up somewhere safe, as rebuilding the sprites needs them.
- **Worktrees that can go:** `issue-17-office-props` and `issue-20-art-record` are merged, and
  `issue-14`, `issue-15` and `issue-16` hold the old drafts above. `omarchy-installer` was
  moved to `issue-68-omarchy-installer`, and can go once #81 is merged.
- **A saved lockfile change**, `~/Projects/Crew-Office-lockfile-backup-2026-11-21.patch`, taken
  from the main checkout before it was updated. It only removed a dependency entry and can be
  deleted.
- **The previous install**, `~/.local/share/crew-office.previous`, is a test build from before
  build 38, kept to roll back to.
