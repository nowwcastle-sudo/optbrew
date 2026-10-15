# Contributing to optbrew

Thanks for helping. optbrew is one skill and a small CLI, so the process is light. Small fixes can go straight to a pull request; for anything larger, open an issue first so we can agree on the direction.

## Ways to help

- **Report a wrong result.** A check that passed or failed on a real site when it should not have is the most useful report. Include the URL (or a minimal HTML file that shows the problem), the profile (SEO, NEO, AEO, GEO or LLMO), what you expected, what the report said, and the `release_version` from `optbrew doctor --json`.
- **Report a bug** in install, update or the CLI, with the command you ran and its full output.
- **Improve a guide or a translation.** The skill lives in `skills/optbrew/`. The Korean README is `README.ko.md`.
- **Send code.** Fixes and new checks are welcome. A new check needs a test that fails without it.

Please do not paste API keys, tokens or private site data into issues.

## Development setup

You need Node.js 22 or later, and Python 3.10 or later for the Python audit utilities.

```bash
git clone https://github.com/nowwcastle-sudo/optbrew
cd optbrew
npm test
python -m unittest discover -s tests/python -p "test_*.py"
```

The tests run against local fixtures in temporary folders. They make no paid calls and do not touch your real home folder. Some tests are skipped in a plain clone, and that is fine: the update and reinstall tests need the previous release tag (`git fetch --tags`), and four vendoring tests need the upstream source mirrors that only the maintainer keeps.

To try your change in an agent without touching your own setup, install into a scratch project:

```bash
mkdir site
node bin/optbrew.mjs install --agents claude-code --scope project --project ./site
```

## Pull requests

1. Branch from `main` and keep the change focused on one thing.
2. Run `npm test` (and the Python tests if you touched `skills/optbrew/scripts`). Run `npm run scan-secrets` before you commit.
3. If you changed what users see, update `README.md` and, if you can, `README.ko.md`. Add a line to `CHANGELOG.md` under the next version.
4. Open the pull request against `main`. `main` accepts changes only through pull requests and keeps a linear history, so the branch is squashed or rebased when it is merged.

If you are not sure about any of this, open the pull request anyway and say so. We will help.

## Bundled guides

Files under `skills/optbrew/modules/` come from pinned upstream sources listed in `source-lock.json`. Changes there go through `scripts/vendor.mjs` and keep the upstream license notices; see [third-party notices](skills/optbrew/THIRD_PARTY_NOTICES.md). If you want to update an upstream guide, open an issue first.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE) of this repository.
