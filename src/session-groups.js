export function groupSessions(sessions, projects, worktrees, sort) {
  const groups = new Map();
  const recent = (item) => item.recencyAt || item.updatedAt || 0;
  const title = (item) => item.name || item.preview || 'Untitled session';
  const byProject = [...projects].sort((a, b) => b.path.length - a.path.length);
  for (const item of sessions) {
    const cwd = worktrees[item.cwd] || item.cwd;
    const project = byProject.find(
      (p) => cwd === p.path || cwd?.startsWith(p.path + '/'),
    );
    const key = project?.path || cwd || '';
    const name =
      project?.name || cwd?.split('/').filter(Boolean).pop() || 'Other';
    const group = groups.get(key) || {
      key,
      name,
      project: project?.path,
      latest: 0,
      items: [],
    };
    group.items.push(item);
    group.latest = Math.max(group.latest, recent(item));
    groups.set(key, group);
  }
  const alphabetical = sort.startsWith('alpha');
  const direction = sort.endsWith('asc') ? 1 : -1;
  for (const group of groups.values()) {
    group.items.sort(
      (a, b) =>
        direction *
          (alphabetical
            ? title(a).localeCompare(title(b))
            : recent(a) - recent(b)) || a.id.localeCompare(b.id),
    );
  }
  return [...groups.values()].sort(
    (a, b) =>
      direction *
        (alphabetical ? a.name.localeCompare(b.name) : a.latest - b.latest) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
}
