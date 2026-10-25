# Platform installation and update paths

Optbrew v0.3.4 contains one skill source at `skills/optbrew`. The managed CLI can place it at five hosts' documented default paths. A file in a host path proves placement, not that the host discovered, loaded, or invoked the skill. Confirm those three steps in a fresh host session before reporting host support as exercised.

| Host | Managed project target | Managed user target | Discovery and invocation boundary |
|---|---|---|---|
| Codex | `.agents/skills/optbrew` | `~/.agents/skills/optbrew` | [Codex skills](https://learn.chatgpt.com/docs/build-skills) scans repository and user skills and follows links. Test invocation in a fresh task. |
| Claude Code | `.claude/skills/optbrew` | `~/.claude/skills/optbrew` | [Claude Code skills](https://code.claude.com/docs/en/skills) scans those roots. This is separate from the Claude web upload. |
| Cursor | `.cursor/skills/optbrew` | `~/.cursor/skills/optbrew` | [Cursor skills](https://cursor.com/docs/skills) also accepts `.agents/skills`; local user skills are not automatically copied to cloud agents. |
| OpenCode | `.opencode/skills/optbrew` | `~/.config/opencode/skills/optbrew` | [OpenCode skills](https://opencode.ai/docs/skills/) also discovers compatible `.agents` and `.claude` roots. |
| Pi | `.pi/skills/optbrew` | `<agent-dir>/skills/optbrew`, normally `~/.pi/agent/skills/optbrew` | [Pi configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/configuration.md) permits `PI_CODING_AGENT_DIR` overrides and requires project trust for project configuration. |

The CLI maps only these default targets. Custom roots, host policies, remote agents, and session reload behavior need host-specific checks. `--scope project --project ./site` keeps a managed installation inside an isolated project. `--scope user` addresses the user's default host paths and should be chosen deliberately.

## Managed checkout and npm paths

The [README](../README.md) shows the npm, npx, PowerShell, plugin and agent install routes. This section holds the parser-checked commands for a source checkout. Clone `https://github.com/nowwcastle-sudo/optbrew`, create an empty `site` folder, and run them from the repository root. With the npm package installed, replace `node bin/optbrew.mjs` with `optbrew`.

Install into an isolated project folder, after a dry run:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --dry-run --json
node bin/optbrew.mjs install --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --strategy copy --json
node bin/optbrew.mjs doctor --agents codex,claude-code,cursor,opencode,pi --scope project --project ./site --json
```

`--strategy link` is the default; `copy` also works when links are unavailable. The managed record lives under that project's `.optbrew/install`. For one host, replace the comma-separated list with its exact ID. Use `--scope user` only when you intend to install into user-level host directories. The install command checks the bundle manifest and refuses to replace an unmanaged target.

Replay the bundled synthetic fixtures without any provider call. Copy `tests/fixtures/scoring/before.json` and `after.json`, and `tests/fixtures/reports/remote-only.json` with its sibling evidence files, into the current directory first:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs score --input ./before.json --output ./score.json
node bin/optbrew.mjs compare --before ./before.json --after ./after.json --output ./comparison.json
node bin/optbrew.mjs report --input ./remote-only.json --output-dir ./report-output
```

Check for updates, update, and roll back a managed project install:

Bash and PowerShell use the same commands:

```text
node bin/optbrew.mjs check-updates --json
node bin/optbrew.mjs update --scope project --project ./site --json
node bin/optbrew.mjs rollback --scope project --project ./site --release-version 0.3.4 --json
```

Rollback works only between releases that share the evaluation version, so no release before 0.2.0 can be rolled back to. The shown command reports that no earlier release is retained on a fresh 0.3.4 install; it applies once a later release that shares the installed evaluation version has updated the install.

The CLI validates bundle hashes before an install or update. `update` replaces every target in one managed record as a unit. An edited target makes the default update stop; the explicit `--local-changes backup-and-replace` policy retains a readable backup. `rollback --release-version VERSION` works only when that version is in the record's retained prior releases. A fresh installation has no older release.

After a public npm release, `npm install -g optbrew` and `npm update -g optbrew` manage the package in npm. Neither command rewrites an old copied skill target. Run the installed CLI's managed `update` after the package update, then `doctor` and a new-session invocation check. `check-updates --package optbrew --json` is read-only and compares the installed release with the npm registry; without `--package` it returns `local_only`.

## Reinstall after a migration_required update

Release 0.2.0 uses evaluation version 0.4.0, audit protocol 0.2.0 and contract schema 2.0.0. Release 0.1.3 used evaluation version 0.3.0 and 0.1.2 used 0.2.0. The managed updater refuses a change of evaluation version or of a scoring contract file, so `optbrew update` stops with `migration_required` and changes nothing on a managed install of any 0.1.x release. There is no `uninstall` command. Replace the install by hand: the blocks below delete the install's targets and then its managed root, and run `install` again from the 0.2.0 checkout. Scores and baselines made with a 0.1.x release are not comparable with 0.2.0; `compare` returns `not_comparable`, so run the baseline audit again. An output folder or evidence packet from a 0.1.x run is refused with one sentence that tells you to run the audit again in a new folder. A plugin install from a marketplace is not a managed install: it follows the repository and needs no reinstall.

Release 0.3.0 uses evaluation version 0.5.0 and audit protocol 0.3.0, so a managed 0.2.x install stops the same way and the same blocks replace it. Scores, baselines and output folders of a 0.2.x run are not comparable with it and are refused in the same way.

The blocks do not trust the install record. Each one first runs the read-only `node bin/optbrew.mjs reinstall-plan`, which resolves the home directory the way the CLI does (`HOME`, else the operating system's home directory), checks that the record belongs to this scope, that every recorded target is exactly the agent's `skills/optbrew` path (absolute, no `..`, no linked folder on the way, inside the scope or project), and that an existing target is a link to the managed bundle or a real folder holding a bundle manifest. If any check fails it prints the reason, exits with a nonzero code, and the block deletes nothing. Otherwise the shell deletes only the paths it printed: the targets first, then `<scope root>/.optbrew/installs/user` (user scope) or `<project>/.optbrew/install` (project scope), which holds the install record. Because the record goes last, you can run the same block again after a failure. The commands never touch `<scope root>/.optbrew/runs`, where the audit evidence of 0.1.x lives, and never touch an `optbrew-audit` folder; do not delete the whole `.optbrew` folder, which also holds the Google key file. Each agent is installed again with the strategy (`link` or `copy`) the record had, then `doctor` runs. Run the blocks from the 0.2.0 checkout root. If `reinstall-plan` refuses the record, fix or remove the named path by hand and look at it first; the CLI also refuses to overwrite a target it does not own.

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

Between releases that keep the evaluation version and the scoring contract files, `update` and `rollback` work as before. The same refusal and steps apply to any future release that changes the evaluation version or a scoring contract file.

## Native host routes

These are alternatives to the managed CLI. Do not mix their ownership records for the same target path.

- **Agent Skills tool:** Current [Vercel Skills CLI](https://github.com/vercel-labs/skills) documents `npx skills add ./` for a local source and `npx skills update optbrew` for an installation it owns. Run from a checkout containing the skill. Confirm its host selection and destination before writing. The public repository is `https://github.com/nowwcastle-sudo/optbrew`.
- **Claude Code plugin:** `.claude-plugin/marketplace.json` names the plugin `optbrew@optbrew` and serves the `skills/` folder, whose `skills/.claude-plugin/plugin.json` lists `./optbrew`. The served `plugin.json` carries the release version, so installed copies move only when a release changes it; the marketplace entry pins none. The served `plugin.json` also declares one optional setting, `google_api_key` (sensitive): Claude Code keeps it in the system credential store, and the plugin's SessionStart hook (`skills/hooks/`) hands it to the session's shell commands as `CLAUDE_PLUGIN_OPTION_GOOGLE_API_KEY`, which optbrew reads before `OPTBREW_GOOGLE_API_KEY` and the key file when it reaches the session. Set it in terminal `claude` with `/plugin`, **Installed**, optbrew, **Configure options** (the desktop app's Code tab has no `/plugin` screen); a new session picks it up. Measured on 2026-10-18 on Windows, the value did not reach a session the Claude desktop app started (bundled claude.exe 2.1.299), while terminal `claude` 2.1.302 received it; app versus version is not separated, so desktop-app users should use the key file (`key set google`). `key status` reports each source and the one used in `google.sources`. Run `claude plugin marketplace add nowwcastle-sudo/optbrew`, then `claude plugin install optbrew@optbrew` (add `--scope project` to keep it in one project). Later, `claude plugin update optbrew@optbrew` applies the marketplace's newer version and requires a restart. `claude plugin validate .` checks the marketplace and the served plugin from a checkout. The root `.claude-plugin/plugin.json` (version 0.3.4) still loads the whole checkout with `claude --plugin-dir .`. [Claude Code plugin instructions](https://code.claude.com/docs/en/plugins) also describe the interactive `/plugin` path. Marketplace auto-update is a user setting; the marketplace file does not enable it. Verify a fresh-session invocation after a native update.
- **Codex plugin:** `.agents/plugins/marketplace.json` lists the same `optbrew` plugin. Run `codex plugin marketplace add nowwcastle-sudo/optbrew`, then `codex plugin add optbrew@optbrew`, or choose it in `/plugins`. Start a new Codex task afterwards.
- **Pi package:** Current [Pi package instructions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) document `pi install ./local-package`, `pi install npm:package-name@version`, `pi list`, and `pi update --extensions`. `pi install ./` installs from a local checkout when Pi is installed; `pi install npm:optbrew@0.3.4` installs the published npm package. The package's `pi.skills` entry points to `./skills/optbrew`. A project-local package declaration uses Pi's `--local` option and is subject to project trust. Check the installed Pi version's help and package list before updating.
- **Claude web (claude.ai, Claude Desktop, Cowork):** In Customize > Plugins, choose Add > Add marketplace and enter `nowwcastle-sudo/optbrew`, then add `optbrew`. The plugin is saved to your account, so cloud Claude Code sessions receive it too. Turn on Sync automatically for the marketplace, or select Check for updates, to pick up new commits. The marketplace serves `skills/` because claude.ai refuses a plugin with a top-level `bin/` folder. Uploading a ZIP of `skills/` (Add > Upload plugin) also works, but each update needs a new upload.
- **Ordinary ChatGPT chat:** Attach the relevant skill files or ZIP and give the assistant the target and scope. This is attachment-guided use. It is not the Codex installation path and does not establish Work/desktop plugin discovery.

The native syntax above comes from host documentation checked on 2026-10-14. It is documentation evidence, not proof that an installed host accepted the package or called the skill. No host registration, OAuth, account setting, or user-level install is performed by the documentation checks.
