// public/changes.js — the Changes tab's "by turn" view: what each turn changed,
// file by file, and a rich diff of one file's edits within a turn.
import { h, svgUse, ib, fmtTime, oneLine, headerFor, section, renderDiff, parseUnified, lineDiff, langFor, copyBtn } from './events.js';
import { classify } from './classify.js';
import { fileKind, glyph, viewSwitch } from './files.js';

const SHELL_EDITS = new Set(['sedit', 'delete', 'fs']);

/**
 * Turns that changed something, newest first:
 * [{ n, prompt, ts, add, del, live?, files: [{ path, rel, add, del, created, deleted?, git?, edits: [ev…] }], shell: [ev…] }]
 * Where the deck snapshotted a turn (`snap.turns[promptId]`, from git), its
 * files are exactly what changed, however it changed. Otherwise they come
 * from the Edit/Write/MultiEdit/NotebookEdit tools, and commands that edit
 * files (sed -i, rm, mv…) are listed without a diff.
 */
export function turnChanges(events, cwd, snap = null) {
  const turns = []; let cur = null; let n = 0;
  const base = cwd ? (cwd.endsWith('/') ? cwd : cwd + '/') : null;
  const start = (prompt) => { cur = { n, prompt, ts: prompt?.ts || null, add: 0, del: 0, byPath: new Map(), shell: [] }; turns.push(cur); };
  for (const ev of events) {
    if (ev.kind === 'prompt') { n++; start(ev); continue; }
    if (ev.kind !== 'tool' || ev.tool.pending || ev.tool.isError) continue;
    if (!cur) start(null);
    const d = ev.tool.diff;
    if (d?.file) {
      let f = cur.byPath.get(d.file);
      if (!f) cur.byPath.set(d.file, f = { path: d.file, rel: base && d.file.startsWith(base) ? d.file.slice(base.length) : d.file.replace(/^\/Users\/[^/]+/, '~'), add: 0, del: 0, created: false, edits: [] });
      f.add += d.add; f.del += d.del; f.created ||= !!d.created; f.edits.push(ev);
      cur.add += d.add; cur.del += d.del;
    } else if (ev.tool.name === 'Bash' && SHELL_EDITS.has(classify(ev).intent)) cur.shell.push(ev);
  }
  const relOf = (abs) => base && abs.startsWith(base) ? abs.slice(base.length) : abs.replace(/^\/Users\/[^/]+/, '~');
  for (const t of turns) {
    const g = t.prompt && snap?.turns?.[t.prompt.id];
    if (!g) continue;
    const tools = t.byPath;
    t.byPath = new Map(); t.shell = []; t.add = 0; t.del = 0; t.live = !!g.live;
    for (const f of g.files) {
      const abs = `${snap.root}/${f.path}`;
      t.byPath.set(abs, { path: abs, rel: relOf(abs), repoPath: f.path, git: f.status, add: f.add, del: f.del, binary: f.binary, created: f.status === 'A', deleted: f.status === 'D', edits: tools.get(abs)?.edits || [] });
      t.add += f.add; t.del += f.del;
    }
  }
  return turns.filter(t => t.byPath.size || t.shell.length || t.live).reverse()
    .map(({ byPath, ...t }) => ({ ...t, files: [...byPath.values()].sort((a, b) => a.rel.localeCompare(b.rel)) }));
}

/** Five little blocks, green for added and red for removed, like a diffstat. */
function diffBar(add, del) {
  const total = add + del; const g = total ? Math.round((add / total) * 5) : 0;
  return h('span', { class: 'dbar', 'aria-hidden': 'true' }, ...[0, 1, 2, 3, 4].map(i => h('i', { class: total ? (i < g ? 'a' : 'd') : '' })));
}
const stat = (add, del) => h('span', { class: 'dstat' }, add ? h('span', { class: 'add-n' }, `+${add}`) : null, del ? h('span', { class: 'del-n' }, `−${del}`) : null);

/** The by-turn list. `onFile(turn, file)` and `onShell(ev)` open details. */
export function renderTurnList(root, turns, { selected = null, collapsed = new Set(), onFile, onShell, onToggle } = {}) {
  if (!turns.length) { root.replaceChildren(h('div', { class: 'pad muted' }, 'No file changes in this session yet.')); return; }
  const out = [];
  for (const t of turns) {
    const shut = collapsed.has(t.n);
    const nFiles = t.files.length;
    out.push(h('div', { class: `ct-turn${shut ? ' shut' : ''}`, role: 'button', tabindex: '-1', dataset: { turn: t.n }, 'aria-expanded': String(!shut), onclick: () => onToggle?.(t.n) },
      h('span', { class: 'twist' }, svgUse('i-right', 9, shut ? 'Show this turn’s files' : 'Hide this turn’s files')),
      h('span', { class: 'ct-n' }, t.n ? `Turn ${t.n}` : 'Before the first prompt'),
      h('span', { class: 'ct-p', title: t.prompt?.text || '' }, t.prompt ? oneLine(t.prompt.text.replace(/<[^>]+>/g, ' '), 140) : ''),
      h('span', { class: 'ct-m' }, t.live ? h('span', { class: 'ct-live', title: 'this turn is still running' }, 'live') : null,
        nFiles || !t.shell.length ? `${nFiles} file${nFiles === 1 ? '' : 's'}` : `${t.shell.length} by command`, stat(t.add, t.del), t.ts ? h('span', { class: 'ct-t' }, fmtTime(t.ts)) : null)));
    if (shut) continue;
    for (const f of t.files) {
      const key = `${t.n}:${f.path}`;
      const slash = f.rel.lastIndexOf('/');
      out.push(h('div', { class: `ct-file${selected === key ? ' sel' : ''}`, role: 'button', tabindex: '-1', dataset: { key }, title: f.path, onclick: () => onFile?.(t, f) },
        glyph(fileKind(f.rel)),
        h('span', { class: 'ct-name' }, f.rel.slice(slash + 1)),
        slash > 0 ? h('span', { class: 'ct-dir' }, f.rel.slice(0, slash)) : null,
        h('span', { class: 'fsp' }),
        f.created ? h('span', { class: 'ct-new', title: 'created in this turn' }, 'new') : null,
        f.deleted ? h('span', { class: 'ct-del', title: 'deleted in this turn' }, 'deleted') : null,
        f.binary ? h('span', { class: 'ct-x' }, 'binary') : null,
        f.edits.length > 1 ? h('span', { class: 'ct-x', title: `${f.edits.length} edits in this turn` }, `×${f.edits.length}`) : null,
        stat(f.add, f.del), diffBar(f.add, f.del)));
    }
    for (const ev of t.shell) {
      const c = classify(ev);
      out.push(h('div', { class: `ct-file shell${selected === `ev:${ev.id}` ? ' sel' : ''}`, role: 'button', tabindex: '-1', dataset: { key: `ev:${ev.id}` }, title: `${ev.tool.input.command}\n(changed files by command, so no diff was recorded)`, onclick: () => onShell?.(ev) },
        h('span', { class: `fi f-${c.fam}` }, svgUse(c.icon, 15, c.label)), h('span', { class: 'ct-name' }, oneLine(c.text, 120)), h('span', { class: 'fsp' }), h('span', { class: 'ct-x' }, 'no diff')));
    }
  }
  root.replaceChildren(...out);
}

/** Ops for one edit, from its full result (structuredPatch / created content), else from its input. */
export function editOps(ev, detail) {
  const r = detail?.toolUseResult;
  if (Array.isArray(r?.structuredPatch) && r.structuredPatch.length) {
    return parseUnified(r.structuredPatch.map(hk => `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@\n${(hk.lines || []).join('\n')}`).join('\n'));
  }
  if (r?.type === 'create' && typeof r.content === 'string') {
    const lines = r.content.replace(/\n$/, '').split('\n');
    return [{ t: 'hunk', text: `@@ -0,0 +1,${lines.length} @@ new file` }, ...lines.map((b, i) => ({ t: 'add', b, bn: i + 1 }))];
  }
  const inp = ev.tool.input || {};
  if (ev.tool.name === 'Edit') return lineDiff(inp.old_string ?? '', inp.new_string ?? '');
  if (ev.tool.name === 'MultiEdit') return (inp.edits || []).flatMap((e, i) => [{ t: 'hunk', text: `@@ -0 +0 @@ edit ${i + 1}` }, ...lineDiff(e.old_string ?? '', e.new_string ?? '')]);
  if (ev.tool.name === 'Write') return (inp.content ?? '').split('\n').map((b, i) => ({ t: 'add', b, bn: i + 1 }));
  if (ev.tool.name === 'NotebookEdit') return (inp.new_source ?? '').split('\n').map((b) => ({ t: 'add', b }));
  return [];
}

/**
 * Details for one file in one turn: every edit to it, in order, as a rich diff.
 * `edits` is [{ ev, detail }]; `mode` is 'split' | 'unified'.
 */
export function renderTurnFileDiff({ turn, file, edits = [], gitDiff = null }, ctx, mode, onMode) {
  const root = h('div', { class: 'details' });
  const lang = langFor(file.path);
  const body = h('div', { class: 'dbody' });
  const paint = (m) => {
    body.replaceChildren();
    if (gitDiff != null) {
      // The whole turn's change to this file, from the deck's snapshots.
      const word = file.created ? 'New file' : file.deleted ? 'Deleted' : 'Changes in this turn';
      const first = file.edits?.[0];
      body.append(section(word, {
        note: turn.live ? 'so far (turn still running)' : file.edits?.length ? `${file.edits.length} tool edit${file.edits.length === 1 ? '' : 's'}` : 'by commands',
        actions: [first && ctx.jump ? ib('i-right', 'Show the first edit in Events', () => ctx.jump(first), { size: 12 }) : null],
      }, file.binary ? h('div', { class: 'note' }, 'Binary file changed.') : gitDiff.trim() ? renderDiff(parseUnified(gitDiff), { lang, mode: file.created || file.deleted ? 'unified' : m }) : h('div', { class: 'note' }, 'No textual change.')));
      return;
    }
    edits.forEach(({ ev, detail }, i) => {
      const created = ev.tool.diff?.created;
      const d = ev.tool.diff || {};
      const title = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}` : created ? 'New file' : 'Edit';
      body.append(section(title, {
        note: [ev.tool.name, fmtTime(ev.ts)].join(' · '),
        actions: [h('span', { class: 'dstat sm' }, d.add ? h('span', { class: 'add-n' }, `+${d.add}`) : null, d.del ? h('span', { class: 'del-n' }, `−${d.del}`) : null),
          ctx.jump ? ib('i-right', 'Show this edit in Events', () => ctx.jump(ev), { size: 12 }) : null],
      }, renderDiff(editOps(ev, detail), { lang, mode: created ? 'unified' : m })));
    });
  };
  const tag = h('span', { class: 'tic lab' }, glyph(fileKind(file.path)), h('span', {}, 'Changes'));
  root.append(headerFor({
    tag, title: file.rel, nav: false,
    meta: [turn.n ? `Turn ${turn.n}` : 'Before the first prompt', `+${file.add} −${file.del}`, gitDiff == null ? `${edits.length} edit${edits.length === 1 ? '' : 's'}` : null, file.created ? 'created' : file.deleted ? 'deleted' : null],
    actions: [viewSwitch([['split', 'Split'], ['unified', 'Unified']], mode, (m) => { onMode?.(m); paint(m); }),
      copyBtn(file.path, 'Copy path'), ctx.api ? ib('i-open', 'Open in editor', () => ctx.api.openEditor(file.path, 1), { size: 14 }) : null],
  }));
  root.append(body);
  paint(mode);
  return root;
}
