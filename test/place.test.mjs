// Where a session works, for its header: lib/gitinfo.mjs place() against
// throwaway repos, and what public/place.js makes of it for the repo and place chips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { place, remoteInfo } from '../lib/gitinfo.mjs';
import { repoChip, placeChip, aheadBehind } from '../public/place.js';

// Not realpath'd on purpose: on macOS the temp dir is behind a symlink, as /tmp is.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-place-'));
const real = fs.realpathSync(root);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'pipe' }).toString().trim();
function repo(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'first');
  return dir;
}

test('remoteInfo: scp-like, ssh and https URLs; credentials dropped; local paths', () => {
  assert.deepEqual(remoteInfo('git@gitlab.example.com:team/sub/tool.git'), { host: 'gitlab.example.com', path: 'team/sub/tool', name: 'sub/tool' });
  assert.deepEqual(remoteInfo('ssh://git@git.example.org:2222/team/tool.git'), { host: 'git.example.org', path: 'team/tool', name: 'team/tool' });
  assert.deepEqual(remoteInfo('https://user:secret@code.example.com/team/tool/'), { host: 'code.example.com', path: 'team/tool', name: 'team/tool' });
  assert.equal(remoteInfo('/srv/git/tool.git').name, 'git/tool');
  assert.equal(remoteInfo('/srv/git/tool.git').host, null);
  assert.equal(remoteInfo(''), null);
});

test('place: a plain folder is not a repo; the chip is a folder', async () => {
  const dir = path.join(root, 'plain'); fs.mkdirSync(dir);
  const p = await place(dir);
  assert.deepEqual(p, { repo: false, cwd: dir });
  assert.deepEqual(repoChip(p), { kind: 'folder', icon: 'i-folder', text: 'plain', title: `Folder ${dir} · not a git repo` });
  assert.equal(placeChip(p), null, 'no branch chip outside a repo');
  assert.equal(repoChip(null), null, 'nothing until the place is known');
});

test('place: a GitHub origin names owner/repo; a branch is measured against main', async () => {
  const dir = repo('gh');
  git(dir, 'remote', 'add', 'origin', 'git@github.com:octo/widgets.git');
  git(dir, 'switch', '-qc', 'feature');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'b');
  const p = await place(dir);
  assert.equal(p.repo, true);
  assert.equal(p.worktree, null);
  assert.equal(p.branch, 'feature');
  assert.deepEqual(p.github, { repo: 'octo/widgets', url: 'https://github.com/octo/widgets' });
  assert.equal(p.remote, null);
  assert.deepEqual(p.base, { branch: 'main', ref: 'main', ahead: 1, behind: 0 }, 'no origin/HEAD fetched: the local main');

  const r = repoChip(p, { tilde: (x) => x.replace(real, '~') });
  assert.equal(r.kind, 'github'); assert.equal(r.text, 'octo/widgets'); assert.equal(r.url, 'https://github.com/octo/widgets');
  assert.equal(r.title, 'octo/widgets on GitHub\n~/gh');
  const c = placeChip(p);
  assert.equal(c.kind, 'branch'); assert.equal(c.icon, 'i-branch'); assert.equal(c.text, 'feature');
  assert.match(c.title, /^Branch feature\n/);
  assert.match(c.title, /\nBase main · 1 ahead\n/);
  // An ended session shows the branch it recorded; the folder having moved on is said on hover.
  const moved = placeChip(p, { recorded: 'older' });
  assert.equal(moved.text, 'older');
  assert.match(moved.title, /The folder is now on feature/);
  assert.doesNotMatch(moved.title, /Base|ahead|behind/, 'the counts are the folder\'s branch, not the one the chip shows');
  assert.equal(placeChip(p, { recorded: 'older', live: true }).text, 'feature', 'a live session is where its folder is now');
});

test('place: another host names its repo; no remote at all names the folder', async () => {
  const a = repo('other');
  git(a, 'remote', 'add', 'origin', 'https://code.example.com/team/other.git');
  const p = await place(a);
  assert.equal(p.github, null);
  assert.deepEqual(p.remote, { name: 'origin', host: 'code.example.com', repo: 'team/other' });
  assert.deepEqual(repoChip(p), { kind: 'remote', icon: 'i-git', text: 'team/other', title: `team/other on code.example.com\n${p.root}` });
  assert.match(placeChip(p).title, /Base main \(this branch\)/);

  const b = repo('lonely');
  const q = await place(b);
  assert.equal(q.remote, null);
  assert.equal(repoChip(q).kind, 'local');
  assert.equal(repoChip(q).text, 'lonely');
});

test('place: a linked worktree gets the worktree chip, based on its main checkout\'s branch', async () => {
  const main = repo('wt-main');
  const wt = path.join(root, 'wt-linked');
  git(main, 'worktree', 'add', '-qb', 'topic', wt);
  git(main, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
  const p = await place(wt);
  assert.equal(p.worktree?.name, 'wt-linked');
  assert.equal(fs.realpathSync(p.worktree.main), fs.realpathSync(main));
  assert.equal(p.branch, 'topic');
  assert.deepEqual({ ...p.base }, { branch: 'main', ref: 'main', ahead: 0, behind: 1 });
  const c = placeChip(p);
  assert.equal(c.kind, 'worktree'); assert.equal(c.icon, 'i-worktree'); assert.equal(c.text, 'topic');
  assert.match(c.title, /^Worktree on topic · of /);
  assert.match(c.title, /Base main · 1 behind/);
  assert.equal(repoChip(p).text, 'wt-main', 'the repo is the main checkout, not the worktree folder');
});

test('place: a repo reached through a symlink is not mistaken for a linked worktree', async () => {
  const dir = repo('real');
  const link = path.join(root, 'link'); fs.symlinkSync(dir, link);
  const p = await place(link);
  assert.equal(p.worktree, null);
});

test('place: a detached HEAD shows its commit', async () => {
  const dir = repo('detached');
  git(dir, 'checkout', '-q', '--detach');
  const p = await place(dir);
  assert.equal(p.branch, null);
  assert.match(placeChip(p).text, /^detached [0-9a-f]{7,}$/);
});

test('aheadBehind', () => {
  assert.equal(aheadBehind({ ahead: 0, behind: 0 }), 'in step');
  assert.equal(aheadBehind({ ahead: 2, behind: 3 }), '2 ahead, 3 behind');
  assert.equal(aheadBehind({}), null);
});
