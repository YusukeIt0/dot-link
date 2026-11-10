// Read immutable Git objects only. GitHub's compare API reports merge-base-to-head
// files for divergent histories, not the content delta between the two endpoints.
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const modes = {blob: new Set(['100644', '100755', '120000']), tree: new Set(['040000']), commit: new Set(['160000'])};

export function endpointReader(api) {
  const commits = new Map(), trees = new Map();
  function treeId(commit) {
    if (!sha(commit)) throw new Error('Invalid evidence commit.');
    if (!commits.has(commit)) {
      const value = api(`git/commits/${commit}`);
      if (value?.sha !== commit || !sha(value.tree?.sha)) throw new Error('Cannot verify evidence commit tree.');
      commits.set(commit, value.tree.sha);
    }
    return commits.get(commit);
  }
  function files(id) {
    if (!trees.has(id)) {
      const value = api(`git/trees/${id}?recursive=1`);
      if (value?.sha !== id || value.truncated !== false || !Array.isArray(value.tree) ||
          value.tree.length > 10_000 || Buffer.byteLength(JSON.stringify(value)) > 2_000_000) return null;
      const paths = new Set(), result = new Map();
      for (const entry of value.tree) {
        if (typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096 ||
            entry.path.split('/').some(part => !part || ['.', '..'].includes(part)) ||
            paths.has(entry.path) || !sha(entry.sha) || !modes[entry.type]?.has(entry.mode)) return null;
        paths.add(entry.path);
        if (entry.type !== 'tree') result.set(entry.path, entry);
      }
      trees.set(id, result);
    }
    return trees.get(id);
  }
  function compare(source, target) {
    const source_tree = treeId(source), target_tree = treeId(target);
    const base = {source, target, source_tree, target_tree, comparison_kind: 'endpoint-content'};
    if (source_tree === target_tree) return {...base, complete: true, files: []};
    const before = files(source_tree), after = files(target_tree);
    if (!before || !after) return {...base, complete: false, files: []};
    const changes = [];
    for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const old = before.get(path), next = after.get(path);
      if (old?.sha === next?.sha && old?.mode === next?.mode && old?.type === next?.type) continue;
      changes.push({filename: path, status: !old ? 'added' : !next ? 'removed' : 'modified',
        before_mode: old?.mode ?? null, after_mode: next?.mode ?? null});
      if (changes.length >= 300) return {...base, complete: false, files: []};
    }
    // No rename inference: a move is explicitly represented as removal/addition.
    return {...base, complete: true, files: changes};
  }
  return {treeId, compare};
}
