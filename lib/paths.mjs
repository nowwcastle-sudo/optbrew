import os from 'node:os';
import path from 'node:path';

const locations = {
  codex: ['.agents/skills/optbrew', '.agents/skills/optbrew'],
  'claude-code': ['.claude/skills/optbrew', '.claude/skills/optbrew'],
  cursor: ['.cursor/skills/optbrew', '.cursor/skills/optbrew'],
  opencode: ['.config/opencode/skills/optbrew', '.opencode/skills/optbrew'],
  pi: ['.pi/agent/skills/optbrew', '.pi/skills/optbrew'],
};

export const supportedAgents = Object.keys(locations);

export function scopePaths({ scope, home = os.homedir(), projectRoot }) {
  if (scope !== 'user' && scope !== 'project') throw new TypeError('scope must be user or project');
  if (scope === 'project' && !projectRoot) throw new TypeError('project scope requires --project');
  const scopeRoot = path.resolve(scope === 'user' ? home : projectRoot);
  return { scopeRoot, managedRoot: path.join(scopeRoot, scope === 'user' ? '.optbrew/installs/user' : '.optbrew/install') };
}

/** Fixed host paths confirmed against current host documentation. */
export function resolveTargets({ agents, scope, home, projectRoot }) {
  const { scopeRoot, managedRoot } = scopePaths({ scope, home, projectRoot });
  if (!Array.isArray(agents) || !agents.length) throw new TypeError('at least one agent required');
  if (new Set(agents).size !== agents.length) throw new TypeError('duplicate agent');
  return agents.map(agent => {
    if (!locations[agent]) throw new TypeError(`unknown agent: ${agent}`);
    return { agent, path: path.join(scopeRoot, locations[agent][scope === 'user' ? 0 : 1]), strategy: 'link', managed_target: path.join(managedRoot, 'bundle') };
  });
}
