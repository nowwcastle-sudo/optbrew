# Install optbrew — instructions for an AI agent

You are an AI coding agent installing the optbrew skill for a user. Follow the steps in order. Each step has a command and a check. Stop and ask the user when a step says so. Do not skip a check.

Package: `optbrew@0.3.2` on npm. Source: https://github.com/nowwcastle-sudo/optbrew

## Rules

- Install only what the user asked for. Do not change other skills, settings or accounts.
- Never delete `.optbrew/runs` or an `optbrew-audit` folder (the user's audit evidence) or a whole `.optbrew` folder (it also holds the user's Google key file). The only deletions in this guide are the paths that the reinstall check in [Update](#update) prints.
- Do not call paid APIs, submit sites to search engines or publish anything. optbrew itself does none of these without the user's approval.
- Show the user the planned changes (step 3) before you install.
- On Windows in PowerShell, write `npx.cmd` wherever this guide says `npx`. Plain `npx` runs `npx.ps1`, which the default execution policy blocks with "running scripts is disabled".

## 1. Ask the user two questions

1. Which agents should get the skill? Valid IDs: `codex`, `claude-code`, `cursor`, `opencode`, `pi`. Default: the agent you are running in.
2. Install for the user account (`user`, every project) or for one project folder (`project`)? Default: `user`.

Write the answers as `AGENTS` (comma-separated, no spaces) and `SCOPE`. For `project`, also get the absolute folder path as `PROJECT`.

## 2. Check Node.js

```text
node -p "process.versions.node"
```

Check: the major version is 22 or higher. If Node.js is missing or older, stop and tell the user to install Node.js 22 or later from https://nodejs.org.

## 3. Show the planned changes

User scope:

```text
npx --yes optbrew@0.3.2 install --agents AGENTS --scope user --dry-run --json
```

Project scope:

```text
npx --yes optbrew@0.3.2 install --agents AGENTS --scope project --project PROJECT --dry-run --json
```

Check: exit code 0 and `"status": "dry_run"`. Show the user `decision.targets[].path` from the output and ask for approval before step 4.

If the output says `existing release differs; use optbrew update`, optbrew is already installed: go to [Update](#update) instead. If it says `unmanaged optbrew target exists`, stop: tell the user the path and ask them what to do with that folder. Do not delete it yourself.

## 4. Install

Run the command from step 3 without `--dry-run`.

Check: exit code 0 and `"status": "installed"` (or `"unchanged"` when the same release was already in place).

## 5. Verify

```text
npx --yes optbrew@0.3.2 doctor --agents AGENTS --scope SCOPE --json
```

Add `--project PROJECT` for project scope. Check: every entry in `targets` has `file_present: true`, `hash_ok: true` and `registered: true`. `session_discovery` and `invocation_verified` are always `not_verified`: doctor checks files, not whether the agent loaded them. A new agent session in step 6 confirms that.

## 6. Hand over

Tell the user:

- The skill is installed for AGENTS (SCOPE scope).
- Start a new agent session. Then say "run optbrew" (or "optbrew 실행해") with the site URL and the goal, for example search traffic, Naver visibility, or AI answer citations.
- optbrew asks for the URL first if it is missing. Then it checks the setup and sends all start questions in one message. The user can answer each number or reply "시작" (start) to accept the defaults.
- The audit then runs in one go and writes `report.html`, `report.md` and `report.json` to `optbrew-audit/<site>-<date>` in the working folder. The user opens `report.html` first.
- A Google API key is optional. It fills the real-visitor speed scores. The user saves it from their own terminal with `optbrew key set google` (or the `key.mjs` command that the key guide shows). Never ask the user to paste a key into the chat, and never read the key file.

## Update

1. Find the installed release: run `npx --yes optbrew@0.3.2 doctor --agents AGENTS --scope SCOPE --json` (add `--project PROJECT` for project scope) and read `release_version`.
2. Find the latest release: `npm view optbrew version`.
3. If they are equal, stop: nothing to update.
4. Otherwise run `npx --yes optbrew@latest update --scope SCOPE --json` (add `--project PROJECT` for project scope). Check: `"status": "updated"`. Then repeat step 5 with `optbrew@latest`.

If `update` stops with `migration_required`, the installed release scores with an older evaluation version and cannot be updated in place. Its scores are not comparable with the new release. Every managed 0.1.x install ends here when it is updated to 0.2.0. Tell the user that an output folder from a 0.1.x audit cannot be reused: the new release refuses it with one sentence, and the audit has to run again in a new folder. Reinstall it:

1. `git clone --depth 1 --branch v0.3.2 https://github.com/nowwcastle-sudo/optbrew optbrew-src` (needs git; use the tag of the release you install).
2. In `optbrew-src`, run the read-only check from https://github.com/nowwcastle-sudo/optbrew/blob/v0.3.2/docs/platforms.md#reinstall-after-a-migration_required-update: `node bin/optbrew.mjs reinstall-plan --scope SCOPE` (add `--project PROJECT` for project scope).
3. Show the user the printed `delete-link` and `delete-dir` paths and ask for approval. If the check refuses the install record, stop and show the user the message.
4. After approval, run the block from that section that matches the user's shell (PowerShell or Bash) and scope, from `optbrew-src`. It deletes only the printed paths, installs again and runs doctor.

## Troubleshooting

| Message | What to do |
|---|---|
| `running scripts is disabled` (PowerShell) | Use `npx.cmd` instead of `npx`. |
| `npx` cannot find `optbrew` | Check network access to the npm registry, then retry once. |
| `unmanaged optbrew target exists` | Stop. Show the path to the user and ask. |
| `bundle integrity failed` | Stop. Report the full message to the user. |
| `doctor` shows `hash_ok: false` | Read the doctor `warnings`. If one says `migration_required`, the install is an older release: follow [Update](#update). Otherwise someone edited the installed files: ask the user before you run `npx --yes optbrew@0.3.2 update --scope SCOPE --local-changes backup-and-replace --json`, which keeps a backup of the edited files. |
