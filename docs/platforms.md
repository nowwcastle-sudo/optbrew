# Platform installation and update paths

Optbrew v0.1.1 contains one skill source at `skills/optbrew`. The managed CLI can place it at five hosts' documented default paths. A file in a host path proves placement, not that the host discovered, loaded, or invoked the skill. Confirm those three steps in a fresh host session before reporting host support as exercised.

| Host | Managed project target | Managed user target | Discovery and invocation boundary |
|---|---|---|---|
| Codex | `.agents/skills/optbrew` | `~/.agents/skills/optbrew` | [Codex skills](https://learn.chatgpt.com/docs/build-skills) scans repository and user skills and follows links. Test invocation in a fresh task. |
| Claude Code | `.claude/skills/optbrew` | `~/.claude/skills/optbrew` | [Claude Code skills](https://code.claude.com/docs/en/skills) scans those roots. This is separate from the Claude web upload. |
| Cursor | `.cursor/skills/optbrew` | `~/.cursor/skills/optbrew` | [Cursor skills](https://cursor.com/docs/skills) also accepts `.agents/skills`; local user skills are not automatically copied to cloud agents. |
| OpenCode | `.opencode/skills/optbrew` | `~/.config/opencode/skills/optbrew` | [OpenCode skills](https://opencode.ai/docs/skills/) also discovers compatible `.agents` and `.claude` roots. |
| Pi | `.pi/skills/optbrew` | `<agent-dir>/skills/optbrew`, normally `~/.pi/agent/skills/optbrew` | [Pi configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md) permits `PI_CODING_AGENT_DIR` overrides and requires project trust for project configuration. |

The CLI maps only these default targets. Custom roots, host policies, remote agents, and session reload behavior need host-specific checks. `--scope project --project ./site` keeps a managed installation inside an isolated project. `--scope user` addresses the user's default host paths and should be chosen deliberately.

## Managed checkout and npm paths

The [README](../README.md) shows parser-checked checkout commands for install, doctor, update, and rollback. The CLI validates bundle hashes before an install or update. `update` replaces every target in one managed record as a unit. An edited target makes the default update stop; the explicit `--local-changes backup-and-replace` policy retains a readable backup. `rollback --release-version VERSION` works only when that version is in the record's retained prior releases. A fresh installation has no older release.

After a public npm release, `npm install -g optbrew` and `npm update -g optbrew` manage the package in npm. Neither command rewrites an old copied skill target. Run the installed CLI's managed `update` after the package update, then `doctor` and a new-session invocation check. `check-updates --json` is read-only; without a confirmed registry name it returns `local_only`. The package is not public merely because `package.json` names it.

## Native host routes

These are alternatives to the managed CLI. Do not mix their ownership records for the same target path.

- **Agent Skills tool:** Current [Vercel Skills CLI](https://github.com/vercel-labs/skills) documents `npx skills add ./` for a local source and `npx skills update optbrew` for an installation it owns. Run from a checkout containing the skill. Confirm its host selection and destination before writing. The public repository is `https://github.com/nowwcastle-sudo/optbrew`.
- **Claude Code plugin:** The local `.claude-plugin/marketplace.json` and `plugin.json` name `optbrew@optbrew-local` at version 0.1.1. The installed Claude CLI help accepts `claude plugin marketplace add --scope project .`, then `claude plugin install --scope project optbrew@optbrew-local` from this checkout. Later, `claude plugin update --scope project optbrew@optbrew-local` applies the marketplace's newer version and requires a restart. These commands change Claude settings, so documentation checks inspect `--help` without registering a marketplace. [Claude Code plugin instructions](https://code.claude.com/docs/en/plugins) also describe the interactive `/plugin` path. Marketplace auto-update is a user setting; the marketplace file does not enable it. Verify the selected release version and a fresh-session invocation after a native update.
- **Pi package:** Current [Pi package instructions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) document `pi install ./local-package`, `pi install npm:package-name@version`, `pi list`, and `pi update --extensions`. `pi install ./` installs from a local checkout when Pi is installed; `pi install npm:optbrew@0.1.1` installs the published npm package. The package's `pi.skills` entry points to `./skills/optbrew`. A project-local package declaration uses Pi's `--local` option and is subject to project trust. Check the installed Pi version's help and package list before updating.
- **Claude web:** Upload the built skill ZIP manually in the supported web interface. Upload a new ZIP again for each update. There is no verified automatic update of that upload.
- **Ordinary ChatGPT chat:** Attach the relevant skill files or ZIP and give the assistant the target and scope. This is attachment-guided use. It is not the Codex installation path and does not establish Work/desktop plugin discovery.

The native syntax above comes from host documentation checked on 2026-10-14. It is documentation evidence, not proof that an installed host accepted the package or called the skill. No host registration, OAuth, account setting, or user-level install is performed by the documentation checks.
