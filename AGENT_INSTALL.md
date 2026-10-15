# Install optbrew — instructions for an AI agent

You are an AI coding agent installing the optbrew skill for a user. Follow the steps in order. Each step has a command and a check. Stop and ask the user when a step says so. Do not skip a check.

Package: `optbrew@0.1.3` on npm. Source: https://github.com/nowwcastle-sudo/optbrew

## Rules

- Install only what the user asked for. Do not change other skills, settings or accounts.
- Never delete a folder named `.optbrew` or anything under `.optbrew/runs` (the user's audit evidence).
- Do not call paid APIs, submit sites to search engines or publish anything. optbrew itself does none of these without the user's approval.
- Show the user the planned changes (step 3) before you install.

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
npx --yes optbrew@0.1.3 install --agents AGENTS --scope user --dry-run --json
```

Project scope:

```text
npx --yes optbrew@0.1.3 install --agents AGENTS --scope project --project PROJECT --dry-run --json
```

Check: exit code 0 and `"status": "dry_run"`. Show the user `decision.targets[].path` from the output and ask for approval before step 4.

If the output says `existing release differs; use optbrew update`, go to [Update](#update) instead. If it says a target exists that optbrew does not own, stop: tell the user the path and ask them what to do with that folder. Do not delete it yourself.

## 4. Install

Run the command from step 3 without `--dry-run`.

Check: exit code 0 and `"status": "installed"` (or `"unchanged"` when the same release was already in place).

## 5. Verify

```text
npx --yes optbrew@0.1.3 doctor --agents AGENTS --scope SCOPE --json
```

Add `--project PROJECT` for project scope. Check: every entry in `targets` has `file_present: true`, `hash_ok: true` and `registered: true`. `session_discovery` and `invocation_verified` are always `not_verified`: doctor checks files, not whether the agent loaded them. A new agent session in step 6 confirms that.

## 6. Hand over

Tell the user:

- The skill is installed for AGENTS (SCOPE scope).
- Start a new agent session. Then say "run optbrew" (or "optbrew 실행해") with the site URL and the goal, for example search traffic, Naver visibility, or AI answer citations.
- optbrew asks for the URL and the goal first if they are missing.

## Update

```text
npx --yes optbrew@latest check-updates --package optbrew --json
npx --yes optbrew@latest update --scope SCOPE --json
```

Add `--project PROJECT` to `update` for project scope. Check: `"status": "updated"` or `"unchanged"`.

If `update` stops with `migration_required`, the installed release uses an older evaluation version. Follow https://github.com/nowwcastle-sudo/optbrew/blob/main/docs/platforms.md#reinstall-after-a-migration_required-update from a checkout of the new release. Those blocks first run a read-only check and delete only the paths it prints. Show the user that output before you run them.

## Troubleshooting

| Message | What to do |
|---|---|
| `npx` cannot find `optbrew` | Check network access to the npm registry, then retry once. |
| `unmanaged optbrew target exists` | Stop. Show the path to the user and ask. |
| `bundle integrity failed` | Stop. Report the full message to the user. |
| `doctor` shows `hash_ok: false` | Someone edited the installed files. Ask the user before you run `update --local-changes backup-and-replace`. |
