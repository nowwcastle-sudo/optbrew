import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    result = result.replace(/\]\(guide\/[^)]+\)(\s+—\s+`([^`]+)`)/g, (_all, suffix, guid) => `](https://searchadvisor.naver.com/guide/${guid})${suffix}`);
    transformations.push('INDEX links point to official Naver URLs; article bodies excluded');
  }
  if (module.module_id === 'naver-searchadvisor' && upstream === 'NOTICE.md') {
    result = `> optbrew distribution note: The upstream notice below is preserved for attribution. This bundle excludes all 55 Naver article bodies and the article-fetch tool. Its statements about the upstream repository's contents and workflow do not describe this package.\n\n${result}`;
    transformations.push('Prepended distribution-specific exclusion notice; original upstream notice preserved below');
  }
  if (module.module_id === 'seranking-seo') {
    const before = result;
    result = result.replace(/(?:bash\s+)?extensions\/(?:google|firecrawl)\/install\.sh/g, 'optbrew capability setup (see top-level routing)');
    result = result.replace(/(?:python3?\s+)?scripts\/[\w-]+\.py(?:\s+--[\w-]+(?:\s+--[\w-]+)*)?/g, 'optbrew read-only capability (see top-level routing)');
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

async function writeNewOrIdentical(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const old = await readFile(target);
    if (!old.equals(bytes)) throw new Error(`existing file differs; back up before replacing: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(target, bytes);
  }
}

export async function vendor({ sourcesRoot = defaultSources, outputRoot = repoRoot, configPath = path.join(repoRoot, 'scripts/vendor.config.json'), patchSet = {} } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
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
      const distributed = upstream === module.license_path || !transformable
        ? bytes
        : Buffer.from(transformText(module, upstream, bytes.toString('utf8'), selectedPaths, transformations));
      outputs.push([destination, distributed]);
      lock.files.push({ module_id: module.module_id, repo: module.repo, commit: module.commit, license: module.license, license_blob_sha: module.license_blob_sha, upstream_path: upstream, package_path: destination, original_git_blob_sha: gitBlob, original_sha256: sha(bytes, 'sha256'), distributed_sha256: sha(distributed, 'sha256'), transformations: [...new Set(transformations)], patch_reason: transformations.length ? 'Portable optbrew GUIDE and capability routing' : null, excluded_files: module.excluded_files });
    }
  }
  const notice = ['# Third-party notices', '', 'The files below retain their upstream copyright and permission notices. Service accounts, API data and Naver guide article bodies are outside these code licenses.', ''];
  for (const module of lock.modules) notice.push(`- **${module.module_id}** — ${module.repo} at ${module.commit}; ${module.license}; Git license blob ${module.license_blob_sha}; exact notice: [licenses/${module.module_id}.txt](licenses/${module.module_id}.txt). Exclusions: ${module.excluded_files.join('; ')}.`);
  outputs.push(['skills/optbrew/THIRD_PARTY_NOTICES.md', Buffer.from(notice.join('\n') + '\n')]);
  outputs.push(['skills/optbrew/source-lock.json', Buffer.from(JSON.stringify(lock, null, 2) + '\n')]);
  for (const [destination, bytes] of outputs) await writeNewOrIdentical(path.join(outputRoot, destination), bytes);
  return lock;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--sources-root');
  vendor({ sourcesRoot: index >= 0 ? path.resolve(process.argv[index + 1]) : defaultSources }).then(lock => {
    process.stdout.write(`vendored ${lock.modules.length} modules, ${lock.files.length} files\n`);
  }).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
