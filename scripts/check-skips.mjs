// Reads the log of `npm test -- --test-reporter=spec` and fails when a test was skipped for a reason nobody expects.
// scripts/test.mjs prints one summary per phase: first every test file but Chrome's, then the Chrome files.
//   node scripts/check-skips.mjs <log file>
import { readFileSync } from 'node:fs';

// The spec reporter prints a skipped test as "﹣ <name> (<ms>) # <reason>" and each phase ends with "ℹ skipped <n>".
const SKIPPED_TEST = /^\s*﹣ .* # (.*)$/;
const SUMMARY = /^\S+ skipped (\d+)$/;
// Skips that are by design on a CI runner. The reasons are the ones the tests give: vendor.test.mjs (no upstream mirror),
// keys.test.mjs (Windows has no POSIX modes) and tests/support/checkout-eol.mjs (a CRLF checkout, which the Windows job makes on purpose).
const ALLOWED_REASONS = [
  /^maintainer-only: /,
  /^Windows has no POSIX modes$/,
  /^skill files are CRLF in this checkout \(core\.autocrlf=true\); /,
];

const phases = [[]];
const counts = [];
for (const line of readFileSync(process.argv[2], 'utf8').split(/\r?\n/)) {
  const summary = SUMMARY.exec(line);
  if (summary) { counts.push(Number(summary[1])); phases.push([]); continue; }
  const skipped = SKIPPED_TEST.exec(line);
  if (skipped) phases.at(-1).push(skipped[1]);
}
phases.pop();

const problems = [];
if (counts.length !== 2) problems.push(`expected 2 phase summaries, found ${counts.length}`);
phases.forEach((reasons, index) => {
  if (reasons.length !== counts[index]) problems.push(`phase ${index + 1} says ${counts[index]} skipped but the log lists ${reasons.length}: the log format changed`);
});
if (counts[1] !== 0) problems.push(`a Chrome test was skipped (${counts[1]}): Chrome did not start on this runner`);
for (const reason of new Set((phases[0] ?? []).filter(reason => !ALLOWED_REASONS.some(allowed => allowed.test(reason)))))
  problems.push(`a test was skipped for an unexpected reason: ${reason}`);

console.log(`skipped per phase (other files, Chrome files): ${counts.join(', ')}`);
for (const reason of new Set(phases.flat())) console.log(`  skip reason: ${reason}`);
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
