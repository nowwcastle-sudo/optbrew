import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { endpoints } from '../skills/optbrew/scripts/core/config.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultSources = path.resolve(repoRoot, '../../../work/seo-alternatives/sources');
const sha = (bytes, algorithm) => createHash(algorithm).update(bytes).digest('hex');
const blobSha = bytes => sha(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]), 'sha1');
const slash = name => name.replaceAll('\\', '/');

async function filesUnder(full, relative) {
  const stat = await lstat(full);
  if (stat.isSymbolicLink()) throw new Error(`symlink source forbidden: ${relative}`);
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) throw new Error(`unsupported source: ${relative}`);
  const out = [];
  for (const entry of await readdir(full, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    out.push(...await filesUnder(path.join(full, entry.name), slash(path.posix.join(relative, entry.name))));
  }
  return out;
}

function normalizeRelative(relative) {
  if (relative.startsWith('/') || relative.includes('\\') || relative.split('/').includes('..')) throw new Error(`path escape: ${relative}`);
  return relative;
}

function withoutFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/^\s*\n/, '');
}

function naverGuide(source) {
  const routing = source.slice(source.indexOf('## 라우팅 표'), source.indexOf('## 자주 쓰는 수치'));
  if (!routing.startsWith('## 라우팅 표') || !routing.includes('## 구조화된 데이터 타입 표')) throw new Error('Naver source guide structure changed');
  return `# Naver Search Advisor source guide\n\nAdapted from the pinned upstream SKILL.md. Naver's 55 article bodies are excluded because their copyright is outside the upstream MIT license. The source routing tables below identify topics only. Find each document in [the official document index](references/INDEX.md) and read its current official URL before using a policy or numeric claim. If the page cannot be read, mark that claim unknown. A site: search is not complete indexing proof; IndexNow is a notification, not confirmed indexing. The local audit script gathers evidence only and must not submit to Naver.\n\nThe upstream instructions to read local article bodies, search those bodies, or fetch them into this package do not apply to optbrew.\n\n${routing.replaceAll('references/guide/', 'official URLs in references/INDEX.md').trimEnd()}\n`;
}

function mapOutput(module, upstream) {
  const local = module.strip_prefix && upstream.startsWith(module.strip_prefix) ? upstream.slice(module.strip_prefix.length) : upstream;
  return slash(path.posix.join('skills/optbrew/modules', module.module_id, local.replace(/(^|\/)SKILL\.md$/, '$1GUIDE.md')));
}

function transformText(module, upstream, text, selected, transformations) {
  let result = text.replace(/\r\n/g, '\n');
  if (upstream.endsWith('/SKILL.md') || upstream === 'SKILL.md') {
    result = withoutFrontmatter(result);
    transformations.push('SKILL.md to GUIDE.md; YAML frontmatter removed');
  }
  if (module.module_id === 'naver-searchadvisor' && upstream === 'SKILL.md') {
    transformations.push('Replaced offline copyrighted-guide workflow with official-index routing');
    return naverGuide(result);
  }
  if (module.module_id === 'naver-searchadvisor' && upstream === 'scripts/audit.mjs') {
    result = result.replace('references/guide/14-content-abusing.md, 15-content-basic.md', 'official Naver guide URLs (see references/INDEX.md)');
    result = result.replaceAll('references/guide/', 'references/INDEX.md (official URLs)');
    transformations.push('Audit output routes policy evidence to official URL index');
  }
  if (module.module_id === 'naver-searchadvisor' && upstream === 'references/INDEX.md') {
    result = result.replace(/\]\(guide\/[^)]+\)(\s+—\s+`([^`]+)`)/g, (_all, suffix, guid) => `](${endpoints().naver_guide}${guid})${suffix}`);
    transformations.push('INDEX links point to official Naver URLs; article bodies excluded');
  }
  if (module.module_id === 'naver-searchadvisor' && upstream === 'NOTICE.md') {
    result = `> optbrew distribution note: The upstream notice below is preserved for attribution. This bundle excludes all 55 Naver article bodies and the article-fetch tool. Its statements about the upstream repository's contents and workflow do not describe this package.\n\n${result}`;
    transformations.push('Prepended distribution-specific exclusion notice; original upstream notice preserved below');
  }
  if (module.module_id === 'seranking-seo') {
    const before = result;
    if (upstream === 'skills/seo-google/SKILL.md') {
      result = result.replace(/^\*\*Script:\*\* `(?:python3?\s+)?scripts\/indexing_notify\.py[^`]*`.*$/gm, '**Execution:** Submission disabled in optbrew. No publish or batch command is bundled. Separate user authority and an approved submission path are required.');
      transformations.push('Google index and index-batch submission commands disabled');
    }
    if (upstream === 'skills/seo-google/references/indexing-api.md') {
      result = `> optbrew distribution notice: Submission disabled. The POST publish and batch examples below document upstream behavior; do not execute them from optbrew. A separate user authority decision and approved submission path are required.\n\n${result}`;
      transformations.push('Indexing API write examples marked disabled pending separate authority');
    }
    result = result.replace(/(?:bash\s+)?extensions\/(?:google|firecrawl)\/install\.sh/g, 'optbrew capability setup (see top-level routing)');
    result = result.replace(/(?:python3?\s+)?scripts\/indexing_notify\.py(?:[^`\n]*)?/g, 'submission disabled in optbrew; separate authority required');
    result = result.replace(/(?:python3?\s+)?scripts\/[\w-]+\.py(?:\s+--[\w-]+(?:\s+--[\w-]+)*)?/g, 'upstream script excluded; use optbrew capability routing');
    if (result !== before) transformations.push('Upstream install/auth/script commands disabled; optbrew capability routing required');
  }
  if (upstream.endsWith('.md')) {
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (all, label, target) => {
      if (/^(?:https?:|mailto:|#)/i.test(target)) return all;
      const [file, anchor] = target.split('#', 2);
      const resolved = slash(path.posix.normalize(path.posix.join(path.posix.dirname(upstream), decodeURIComponent(file))));
      if (!selected.has(resolved)) {
        transformations.push(`Unbundled relative link ${target} changed to upstream-only text`);
        return `${label} (upstream-only reference; route through optbrew)`;
      }
      const mapped = resolved === module.license_path
        ? `skills/optbrew/licenses/${module.module_id}.txt`
        : mapOutput(module, resolved);
      const from = path.posix.dirname(mapOutput(module, upstream));
      const rewritten = path.posix.relative(from, mapped) || path.posix.basename(mapped);
      return `[${label}](${rewritten}${anchor ? `#${anchor}` : ''})`;
    });
    if (!(module.module_id === 'naver-searchadvisor' && (upstream === 'NOTICE.md' || upstream === 'SKILL.md'))) {
      const mappedNames = result.replaceAll('SKILL.md', 'GUIDE.md');
      if (mappedNames !== result) transformations.push('Inline SKILL.md mentions mapped to GUIDE.md');
      result = mappedNames;
    }
    if (module.module_id === 'magnus-seo' && ['seo/references/content-strategy-seo.md', 'seo/references/onpage-seo.md'].includes(upstream)) {
      const tidy = result.replace(/[ \t]+$/gm, '');
      if (tidy !== result) transformations.push('Removed source trailing whitespace for clean Git diff');
      result = tidy;
    }
  }
  return result;
}

function sourceMetadata(sourceDir, module) {
  if (module.module_id === 'marketing-search') {
    const head = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const remote = execFileSync('git', ['-C', sourceDir, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    if (head !== module.commit || !remote.replace(/\.git$/, '').endsWith(`/${module.repo}`)) throw new Error(`source identity mismatch: ${module.module_id}`);
    const listing = execFileSync('git', ['-C', sourceDir, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8' });
    return new Map(listing.split(/\r?\n/).filter(Boolean).map(line => {
      const match = line.match(/^\d+ blob ([0-9a-f]{40})\t(.+)$/);
      return match ? [match[2], match[1]] : [line, null];
    }));
  }
  return null;
}

async function optionalRead(target) {
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error(`existing symlink rejected: ${target}`);
    return await readFile(target);
  }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function reviewedReplacement(configPath, patch, base) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(patch.id ?? '') || !patch.reason?.trim()) throw new Error('invalid reviewed patch identity or reason');
  if (!/^[0-9a-f]{64}$/.test(patch.expected_base_sha256 ?? '') || !/^[0-9a-f]{64}$/.test(patch.replacement_sha256 ?? '')) throw new Error(`invalid reviewed patch hash: ${patch.id}`);
  if (sha(base, 'sha256') !== patch.expected_base_sha256) throw new Error(`reviewed patch base hash mismatch: ${patch.id}`);
  const relative = normalizeRelative(patch.replacement_path ?? '');
  if (!relative.startsWith('patches/')) throw new Error(`reviewed patch outside patches/: ${patch.id}`);
  const patchRoot = path.join(path.dirname(configPath), 'patches');
  const patchRootStat = await lstat(patchRoot);
  if (!patchRootStat.isDirectory() || patchRootStat.isSymbolicLink()) throw new Error(`reviewed patch directory invalid: ${patch.id}`);
  const patchFile = path.join(path.dirname(configPath), relative);
  const fileStat = await lstat(patchFile);
  const inside = path.relative(await realpath(patchRoot), await realpath(patchFile));
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`reviewed patch path invalid: ${patch.id}`);
  const replacement = await readFile(patchFile);
  if (sha(replacement, 'sha256') !== patch.replacement_sha256) throw new Error(`reviewed patch replacement hash mismatch: ${patch.id}`);
  return replacement;
}

async function writeOutputs(outputRoot, outputs) {
  const lockName = 'skills/optbrew/source-lock.json';
  const previousBytes = await optionalRead(path.join(outputRoot, lockName));
  let previous = null;
  if (previousBytes) {
    try { previous = JSON.parse(previousBytes.toString('utf8')); }
    catch { throw new Error('existing source-lock is invalid; local edit rejected'); }
    if (!previousBytes.equals(Buffer.from(JSON.stringify(previous, null, 2) + '\n'))) throw new Error('existing source-lock differs from generated form; local edit rejected');
    let gitRoot = null;
    try { gitRoot = execFileSync('git', ['-C', outputRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' }).trim(); }
    catch { /* Temporary output directory outside Git. */ }
    if (gitRoot && path.resolve(gitRoot).toLowerCase() === path.resolve(outputRoot).toLowerCase()) {
      let committed;
      try { committed = execFileSync('git', ['-C', outputRoot, 'show', `HEAD:${lockName}`], { stdio: 'pipe' }); }
      catch { throw new Error('cannot verify existing source-lock against HEAD'); }
      if (!previousBytes.equals(committed) && !previousBytes.equals(outputs.find(([name]) => name === lockName)?.[1])) throw new Error('source-lock has uncommitted local edits');
    }
  }
  const previousHashes = new Map((previous?.files ?? []).map(file => [file.package_path, file.distributed_sha256]));
  const writes = [];
  for (const [name, bytes] of outputs) {
    const target = path.join(outputRoot, name);
    const old = await optionalRead(target);
    if (old?.equals(bytes)) continue;
    if (old && name !== lockName && sha(old, 'sha256') !== previousHashes.get(name)) throw new Error(`existing file differs; local edit rejected: ${target}`);
    writes.push([target, bytes]);
  }
  for (const [target, bytes] of writes) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
}

export async function vendor({ sourcesRoot = defaultSources, outputRoot = repoRoot, configPath = path.join(repoRoot, 'scripts/vendor.config.json'), patchSet = {} } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const patchEntries = [...(config.reviewed_patches ?? []), ...(patchSet.patches ?? [])];
  const patches = new Map();
  const overlays = new Map();
  const patchIds = new Set();
  for (const patch of patchEntries) {
    const key = `${patch.module_id}/${patch.upstream_path}`;
    if (patches.has(key) || patchIds.has(patch.id)) throw new Error(`duplicate reviewed patch: ${patch.id}`);
    patches.set(key, patch);
    patchIds.add(patch.id);
  }
  for (const overlay of config.reviewed_overlays ?? []) {
    const key = `${overlay.module_id}/${overlay.upstream_path}`;
    if (overlays.has(key) || patchIds.has(overlay.id)) throw new Error(`duplicate reviewed overlay: ${overlay.id}`);
    overlays.set(key, overlay);
    patchIds.add(overlay.id);
  }
  const applied = new Set();
  const appliedOverlays = new Set();
  const lock = { schema_version: config.schema_version, modules: [], files: [] };
  const outputs = [];
  for (const module of config.modules) {
    const sourceDir = patchSet.sourceOverrides?.[module.module_id] ?? path.join(sourcesRoot, module.source_dir);
    const manifest = module.module_id === 'marketing-search' ? null : JSON.parse(await readFile(path.join(sourceDir, 'SOURCE-MANIFEST.json'), 'utf8'));
    if (manifest && (manifest.sha !== module.commit || manifest.canonical_repo !== module.repo)) throw new Error(`source identity mismatch: ${module.module_id}`);
    const tree = sourceMetadata(sourceDir, module) ?? new Map(manifest.tree.filter(x => x.type === 'blob').map(x => [x.path, x.sha]));
    const downloaded = new Map((manifest?.downloaded ?? []).map(x => [x.path, x]));
    const selectedPaths = new Set();
    for (const include of module.include) {
      normalizeRelative(include);
      if (module.module_id === 'naver-searchadvisor' && (include === 'references/guide' || include.startsWith('references/guide/'))) throw new Error('forbidden copyrighted Naver guide articles');
      for (const file of await filesUnder(path.join(sourceDir, include), include)) selectedPaths.add(file);
    }
    if (module.module_id === 'naver-searchadvisor' && [...selectedPaths].some(file => file.startsWith('references/guide/'))) throw new Error('forbidden copyrighted Naver guide articles');
    selectedPaths.add(module.license_path);
    const record = { module_id: module.module_id, repo: module.repo, commit: module.commit, license: module.license, license_path: module.license_path, license_blob_sha: module.license_blob_sha, excluded_files: module.excluded_files };
    lock.modules.push(record);
    for (const upstream of [...selectedPaths].sort()) {
      const bytes = module.module_id === 'marketing-search'
        ? execFileSync('git', ['-C', sourceDir, 'show', `HEAD:${normalizeRelative(upstream)}`])
        : await readFile(path.join(sourceDir, normalizeRelative(upstream)));
      const gitBlob = blobSha(bytes);
      if (tree.get(upstream) !== gitBlob) throw new Error(`Git blob mismatch: ${module.module_id}/${upstream}`);
      if (downloaded.has(upstream) && downloaded.get(upstream).sha256 !== sha(bytes, 'sha256')) throw new Error(`snapshot hash mismatch: ${module.module_id}/${upstream}`);
      if (upstream === module.license_path && gitBlob !== module.license_blob_sha) throw new Error(`license blob mismatch: ${module.module_id}`);
      const transformations = [];
      const destination = upstream === module.license_path ? `skills/optbrew/licenses/${module.module_id}.txt` : mapOutput(module, upstream);
      const transformable = /\.(?:md|markdown)$/i.test(upstream) || (module.module_id === 'naver-searchadvisor' && upstream === 'scripts/audit.mjs');
      let distributed = upstream === module.license_path || !transformable
        ? bytes
        : Buffer.from(transformText(module, upstream, bytes.toString('utf8'), selectedPaths, transformations));
      const patchKey = `${module.module_id}/${upstream}`;
      const patch = patches.get(patchKey);
      if (patch) {
        if (upstream === module.license_path) throw new Error(`reviewed patch cannot replace license: ${patch.id}`);
        distributed = await reviewedReplacement(configPath, patch, distributed);
        transformations.push(`reviewed distribution patch ${patch.id}`);
        applied.add(patchKey);
      }
      const overlay = overlays.get(patchKey);
      if (overlay) {
        if (upstream === module.license_path || !destination.endsWith('GUIDE.md')) throw new Error(`reviewed overlay target invalid: ${overlay.id}`);
        const notice = await reviewedReplacement(configPath, overlay, distributed);
        distributed = Buffer.concat([notice, Buffer.from('\n'), distributed]);
        transformations.push(`reviewed distribution overlay ${overlay.id}`);
        appliedOverlays.add(patchKey);
      }
      outputs.push([destination, distributed]);
      lock.files.push({ module_id: module.module_id, repo: module.repo, commit: module.commit, license: module.license, license_blob_sha: module.license_blob_sha, upstream_path: upstream, package_path: destination, original_git_blob_sha: gitBlob, original_sha256: sha(bytes, 'sha256'), distributed_sha256: sha(distributed, 'sha256'), transformations: [...new Set(transformations)], patch_id: patch?.id ?? null, patch_base_sha256: patch?.expected_base_sha256 ?? null, patch_reason: patch?.reason ?? (transformations.length ? 'Portable optbrew GUIDE and capability routing' : null), ...(overlay ? { overlay_id: overlay.id, overlay_base_sha256: overlay.expected_base_sha256, overlay_reason: overlay.reason } : {}), excluded_files: module.excluded_files });
    }
  }
  for (const key of patches.keys()) if (!applied.has(key)) throw new Error(`reviewed patch target not selected: ${key}`);
  for (const key of overlays.keys()) if (!appliedOverlays.has(key)) throw new Error(`reviewed overlay target not selected: ${key}`);
  for (const artifact of config.first_party_files ?? []) {
    const source = normalizeRelative(artifact.source_path ?? '');
    const destination = normalizeRelative(artifact.package_path ?? '');
    if (!source.startsWith('patches/') || !destination.startsWith('skills/optbrew/') || artifact.license !== 'MIT' || !/^[0-9a-f]{64}$/.test(artifact.sha256 ?? '')) throw new Error(`invalid first-party artifact: ${artifact.id}`);
    if (outputs.some(([name]) => name === destination)) throw new Error(`first-party output collision: ${destination}`);
    const patchRoot = await realpath(path.join(path.dirname(configPath), 'patches'));
    const canonical = path.join(path.dirname(configPath), source);
    const stat = await lstat(canonical);
    const inside = path.relative(patchRoot, await realpath(canonical));
    if (!stat.isFile() || stat.isSymbolicLink() || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error(`invalid first-party source: ${source}`);
    const bytes = await readFile(canonical);
    if (sha(bytes, 'sha256') !== artifact.sha256) throw new Error(`first-party artifact hash mismatch: ${artifact.id}`);
    outputs.push([destination, bytes]);
    lock.files.push({ module_id: 'optbrew', repo: null, commit: null, license: 'MIT', license_blob_sha: null, upstream_path: null, package_path: destination, original_git_blob_sha: null, original_sha256: null, distributed_sha256: artifact.sha256, transformations: ['Reviewed first-party artifact copied'], patch_id: null, patch_base_sha256: null, patch_reason: null, excluded_files: [], source_kind: 'first_party', canonical_path: source, canonical_sha256: artifact.sha256 });
  }
  const notice = ['# Third-party notices', '', 'The files below retain their upstream copyright and permission notices. Service accounts, API data and Naver guide article bodies are outside these code licenses.', ''];
  for (const module of lock.modules) notice.push(`- **${module.module_id}** — ${module.repo} at ${module.commit}; ${module.license}; Git license blob ${module.license_blob_sha}; exact notice: [licenses/${module.module_id}.txt](licenses/${module.module_id}.txt). Exclusions: ${module.excluded_files.join('; ')}.`);
  outputs.push(['skills/optbrew/THIRD_PARTY_NOTICES.md', Buffer.from(notice.join('\n') + '\n')]);
  outputs.push(['skills/optbrew/source-lock.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n')]);
  await writeOutputs(outputRoot, outputs);
  return lock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = (flag, fallback) => {
    const index = process.argv.indexOf(flag);
    if (index < 0) return fallback;
    if (!process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`missing value for ${flag}`);
    return path.resolve(process.argv[index + 1]);
  };
  vendor({
    sourcesRoot: argument('--sources-root', defaultSources),
    outputRoot: argument('--output-root', repoRoot),
    configPath: argument('--config-path', path.join(repoRoot, 'scripts/vendor.config.json'))
  }).then(lock => {
    process.stdout.write(`vendored ${lock.modules.length} modules, ${lock.files.length} files\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
