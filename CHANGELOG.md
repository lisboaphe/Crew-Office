# Changelog

## Upgrade: collaboration, Git, rules and budgets (branch `upgrade/collab-git-budgets`)

See [the upgrade report](docs/developer/upgrade-report.md) for the requirement matrix, test results and known limits.

### Added

- **Self-hosted Git.** Per-project repositories on the host over smart HTTP, with authentication, a protected `main`, no force-pushes or deletes, secret scanning, snapshots and rollback, and commit provenance.
- **Agent Git tools.** One clone per agent per task, on its owner's machine; Smart, Live and Manual sync.
- **AI review.** Merge requests, an independent reviewer who reads the real diff, file-and-line comments, rework, conflict handling. Git tasks complete only by merging.
- **Agent rules.** Office → Project → Team → Agent → Task inheritance, shown with its source, versioned, with nine role presets. Optional progress, handoff and README documents.
- **Approval modes.** Manual, Balanced and Autonomous, with safeguards no mode removes.
- **Budget manager and billing safety**, on each owner's worker. Paid API is off by default; estimates are labelled as estimates; limits pause and checkpoint work.
- **Provider connections.** Sign in with ChatGPT; Claude manual handoff; automated Claude Code as an opt-in labelled Limited; connection states and Test Connection.
- **Shared file store** with resumable, verified uploads, versions and quotas, and an Office files tab.
- **Contract dependencies** between projects: targeted notification and an adaptation task.
- **Host backups**, a pause-all button, quiet mode, and a three-player bot demo (`npm run demo:bot`).

### Changed

- A new agent defaults to the ChatGPT plan, never to a paid API.
- `claude-cli` is off unless its owner opts in.
- Finished projects reopen when new work arrives, and are summarised again once it settles.
- The Docker image now includes Git.

### Fixed

- A worker with a bad token could open a Git credential window on someone's screen.
- Project budgets now restart a paused task when raised.
