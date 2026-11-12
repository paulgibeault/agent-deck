// lib/launch.mjs — hooks around POST /api/launch, so features (worktrees,
// workstreams) shape a launch without editing server.mjs. Route modules get
// `onLaunch` in their ctx:
//   onLaunch({
//     before: async (body) => patch,   // may return { cwd, prompt, name, … } to change the launch, or throw (400)
//     failed: async (body, err) => {}, // the launch failed after the befores ran: undo what `before` made
//     after: async (state, body) => {}, // the session started; runs after the response, errors are logged
//   })
// `body` is the whole request body, so a feature reads its own fields from it
// (the page adds them with public/launch.js). The request is checked first
// (a folder that exists, something to send), so a before never acts on one
// that cannot start. Only POST /api/launch runs these: a resume or a move to
// another agent (lib/agent.mjs) keeps the session's folder and does not.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hooks = [];

export function onLaunch(hook) {
  hooks.push(hook);
  return () => { const i = hooks.indexOf(hook); if (i >= 0) hooks.splice(i, 1); };
}

/**
 * Run every `before` in order; each sees the body as the ones before it left it.
 * If one throws, the ones that already ran get `failed`, so they undo what they made.
 */
export async function beforeLaunch(body) {
  const ran = [];
  for (const h of hooks) {
    if (!h.before) continue;
    try { body = { ...body, ...((await h.before(body)) || {}) }; }
    catch (e) { await undo(ran, body, e); throw e; }
    ran.push(h);
  }
  return body;
}

async function undo(list, body, err) {
  for (const h of list) {
    if (!h.failed) continue;
    try { await h.failed(body, err); } catch (e) { console.error(`agent-deck: launch hook failed: ${e.message}`); }
  }
}

export async function failedLaunch(body, err) { await undo(hooks, body, err); }

export async function afterLaunch(state, body) {
  for (const h of hooks) {
    if (!h.after) continue;
    try { await h.after(state, body); } catch (e) { console.error(`agent-deck: launch hook failed: ${e.message}`); }
  }
}

// ---------------------------------------------------------------- the folder
// A launch may name a folder that is not there yet: the dialog says it will be
// made, and the request carries `createCwd`. Without it a missing folder is
// still an error, so a typo does not quietly become a new folder.

/** The folder as typed, made absolute: `~` is the home folder; anything else must already be absolute. */
export function resolveCwd(cwd, home = os.homedir()) {
  let s = String(cwd || '').trim();
  if (s === '~' || s.startsWith('~/')) s = path.join(home, s.slice(1));
  if (!s || !path.isAbsolute(s)) return null;
  return path.resolve(s);
}

/** What is at `dir`: 'dir', 'missing' (and can be made), or 'blocked' (a file is in the way). */
export function folderState(dir) {
  for (let p = dir; ; p = path.dirname(p)) {
    let st = null;
    try { st = fs.statSync(p); } catch (e) { if (e.code !== 'ENOENT') return 'blocked'; }
    if (st) return !st.isDirectory() ? 'blocked' : p === dir ? 'dir' : 'missing';
    if (path.dirname(p) === p) return 'blocked';
  }
}

/** Make `dir` and its missing parents; returns the folders made, deepest first, for `unmakeFolder`. */
export function makeFolder(dir) {
  const made = [];
  for (let p = dir; !fs.existsSync(p); p = path.dirname(p)) made.push(p);
  fs.mkdirSync(dir, { recursive: true });
  return made;
}

/** Undo `makeFolder` after a launch that did not start: only folders still empty go. */
export function unmakeFolder(made) {
  for (const p of made || []) { try { fs.rmdirSync(p); } catch { return; } }
}
