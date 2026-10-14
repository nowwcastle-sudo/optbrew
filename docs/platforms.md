# Platform installation and update paths

Optbrew v0.1.2 contains one skill source at `skills/optbrew`. The managed CLI can place it at five hosts' documented default paths. A file in a host path proves placement, not that the host discovered, loaded, or invoked the skill. Confirm those three steps in a fresh host session before reporting host support as exercised.

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

After a public npm release, `npm install -g optbrew` and `npm update -g optbrew` manage the package in npm. Neither command rewrites an old copied skill target. Run the installed CLI's managed `update` after the package update, then `doctor` and a new-session invocation check. `check-updates --package optbrew --json` is read-only and compares the installed release with the npm registry; without `--package` it returns `local_only`.

## Reinstall after a migration_required update

Release 0.1.2 uses evaluation version 0.2.0; 0.1.1 used 0.1.0. The managed updater refuses a change of evaluation version, so `optbrew update` on a managed 0.1.1 install stops with `migration_required` and changes nothing. There is no `uninstall` command. Replace the install by hand: the blocks below delete the install's targets and then its managed root, and run `install` again from the 0.1.2 checkout. Scores and baselines made with 0.1.1 are not comparable with 0.1.2; `compare` returns `not_comparable` (`evaluation_version_changed`). Run the baseline audit again with 0.1.2.

The blocks do not trust the install record. Each one first runs the read-only `node bin/optbrew.mjs reinstall-plan`, which resolves the home directory the way the CLI does (`HOME`, else the operating system's home directory), checks that the record belongs to this scope, that every recorded target is exactly the agent's `skills/optbrew` path (absolute, no `..`, no linked folder on the way, inside the scope or project), and that an existing target is a link to the managed bundle or a real folder holding a bundle manifest. If any check fails it prints the reason, exits with a nonzero code, and the block deletes nothing. Otherwise the shell deletes only the paths it printed: the targets first, then `<scope root>/.optbrew/installs/user` (user scope) or `<project>/.optbrew/install` (project scope), which holds the install record. Because the record goes last, you can run the same block again after a failure. The commands never touch `<scope root>/.optbrew/runs`, where your audit evidence lives; do not delete the whole `.optbrew` folder. Each agent is installed again with the strategy (`link` or `copy`) the record had, then `doctor` runs. Run the blocks from the 0.1.2 checkout root. If `reinstall-plan` refuses the record, fix or remove the named path by hand and look at it first; the CLI also refuses to overwrite a target it does not own.

User scope:

```powershell user
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$plan = @(node bin/optbrew.mjs reinstall-plan --scope user)
if ($LASTEXITCODE) { exit $LASTEXITCODE }
foreach ($line in $plan) {
  $f = $line -split "`t"
  if ($f[0] -eq 'delete-link') { [IO.Directory]::Delete($f[1]) }
  elseif ($f[0] -eq 'delete-dir') { Remove-Item -Recurse -Force -LiteralPath $f[1] }
}
foreach ($line in $plan) {
  $f = $line -split "`t"
  if ($f[0] -eq 'install') { node bin/optbrew.mjs install --agents $f[1] --scope user --strategy $f[2]; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
  elseif ($f[0] -eq 'agents') { node bin/optbrew.mjs doctor --agents $f[1] --scope user; exit $LASTEXITCODE }
}
```

```bash user
set -e
plan=$(node bin/optbrew.mjs reinstall-plan --scope user)
while IFS=$'\t' read -r kind a b; do
  case "$kind" in delete-link | delete-dir) rm -r -- "$a" ;; esac
done <<< "$plan"
while IFS=$'\t' read -r kind a b; do
  case "$kind" in
    install) node bin/optbrew.mjs install --agents "$a" --scope user --strategy "$b" ;;
    agents) node bin/optbrew.mjs doctor --agents "$a" --scope user ;;
  esac
done <<< "$plan"
```

Project scope (replace `./site` with your project folder; it appears once):

```powershell project
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$project = './site'
$plan = @(node bin/optbrew.mjs reinstall-plan --scope project --project $project)
if ($LASTEXITCODE) { exit $LASTEXITCODE }
foreach ($line in $plan) {
  $f = $line -split "`t"
  if ($f[0] -eq 'delete-link') { [IO.Directory]::Delete($f[1]) }
  elseif ($f[0] -eq 'delete-dir') { Remove-Item -Recurse -Force -LiteralPath $f[1] }
}
foreach ($line in $plan) {
  $f = $line -split "`t"
  if ($f[0] -eq 'install') { node bin/optbrew.mjs install --agents $f[1] --scope project --project $project --strategy $f[2]; if ($LASTEXITCODE) { exit $LASTEXITCODE } }
  elseif ($f[0] -eq 'agents') { node bin/optbrew.mjs doctor --agents $f[1] --scope project --project $project; exit $LASTEXITCODE }
}
```

```bash project
set -e
project='./site'
plan=$(node bin/optbrew.mjs reinstall-plan --scope project --project "$project")
while IFS=$'\t' read -r kind a b; do
  case "$kind" in delete-link | delete-dir) rm -r -- "$a" ;; esac
done <<< "$plan"
while IFS=$'\t' read -r kind a b; do
  case "$kind" in
    install) node bin/optbrew.mjs install --agents "$a" --scope project --project "$project" --strategy "$b" ;;
    agents) node bin/optbrew.mjs doctor --agents "$a" --scope project --project "$project" ;;
  esac
done <<< "$plan"
```

Inside 0.1.2 and later releases that keep evaluation version 0.2.0, `update` and `rollback` work as before. The same refusal and steps apply to any future release that changes the evaluation version.

## Native host routes

These are alternatives to the managed CLI. Do not mix their ownership records for the same target path.

- **Agent Skills tool:** Current [Vercel Skills CLI](https://github.com/vercel-labs/skills) documents `npx skills add ./` for a local source and `npx skills update optbrew` for an installation it owns. Run from a checkout containing the skill. Confirm its host selection and destination before writing. The public repository is `https://github.com/nowwcastle-sudo/optbrew`.
- **Claude Code plugin:** The local `.claude-plugin/marketplace.json` and `plugin.json` name `optbrew@optbrew-local` at version 0.1.2. The installed Claude CLI help accepts `claude plugin marketplace add --scope project .`, then `claude plugin install --scope project optbrew@optbrew-local` from this checkout. Later, `claude plugin update --scope project optbrew@optbrew-local` applies the marketplace's newer version and requires a restart. These commands change Claude settings, so documentation checks inspect `--help` without registering a marketplace. [Claude Code plugin instructions](https://code.claude.com/docs/en/plugins) also describe the interactive `/plugin` path. Marketplace auto-update is a user setting; the marketplace file does not enable it. Verify the selected release version and a fresh-session invocation after a native update.
- **Pi package:** Current [Pi package instructions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) document `pi install ./local-package`, `pi install npm:package-name@version`, `pi list`, and `pi update --extensions`. `pi install ./` installs from a local checkout when Pi is installed; `pi install npm:optbrew@0.1.2` installs the published npm package. The package's `pi.skills` entry points to `./skills/optbrew`. A project-local package declaration uses Pi's `--local` option and is subject to project trust. Check the installed Pi version's help and package list before updating.
- **Claude web:** Upload the built skill ZIP manually in the supported web interface. Upload a new ZIP again for each update. There is no verified automatic update of that upload.
- **Ordinary ChatGPT chat:** Attach the relevant skill files or ZIP and give the assistant the target and scope. This is attachment-guided use. It is not the Codex installation path and does not establish Work/desktop plugin discovery.

The native syntax above comes from host documentation checked on 2026-10-14. It is documentation evidence, not proof that an installed host accepted the package or called the skill. No host registration, OAuth, account setting, or user-level install is performed by the documentation checks.
