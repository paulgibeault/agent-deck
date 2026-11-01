// lib/deckstate.mjs — the deck's own small persistent state (closed
// sessions, stored as `hidden`) and the trash that "delete" moves transcripts into.
// Features keep theirs in a namespace of their own, state.ns('stars'), so
// none of them depends on another's part of state.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export class DeckState {
  constructor(dir = process.env.DECK_STATE_DIR || path.join(os.homedir(), '.agent-deck')) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.trash = path.join(dir, 'trash');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.hidden = new Set(Array.isArray(data.hidden) ? data.hidden : []);
    this.spaces = data.ns && typeof data.ns === 'object' && !Array.isArray(data.ns) ? data.ns : {};
  }

  /**
   * A feature's own corner of state.json: get(key, dflt), set(key, value)
   * (saved at once; undefined deletes), keys(). Values must be plain JSON.
   */
  ns(name) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`bad state namespace: ${name}`);
    const space = () => (this.spaces[name] ||= {});
    return {
      // A copy: changing it changes nothing until set() saves it.
      get: (key, dflt) => Object.hasOwn(this.spaces[name] || {}, key) ? structuredClone(this.spaces[name][key]) : dflt,
      set: (key, value) => {
        if (value === undefined) delete space()[key]; else space()[key] = value;
        if (!Object.keys(space()).length) delete this.spaces[name];
        this._save();
      },
      keys: () => Object.keys(this.spaces[name] || {}),
    };
  }

  /** The launch token, created once and kept (0600) so browser cookies outlive restarts. */
  token() {
    const file = path.join(this.dir, 'token');
    try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch { /* first run */ }
    const t = randomBytes(18).toString('base64url');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(file, t + '\n', { mode: 0o600 });
    return t;
  }

  _save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    const data = { hidden: [...this.hidden] };
    if (Object.keys(this.spaces).length) data.ns = this.spaces;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  setHidden(id, hidden) {
    if (hidden) this.hidden.add(id); else this.hidden.delete(id);
    this._save();
  }

  /**
   * Move a session's transcript (and its sidecar dir: subagents, tool
   * results) into the deck trash. Returns where it went.
   */
  trashSession(id, { file, dir }) {
    const dest = path.join(this.trash, `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`);
    fs.mkdirSync(dest, { recursive: true });
    const move = (src) => {
      if (!src || !fs.existsSync(src)) return;
      const to = path.join(dest, path.basename(src));
      try { fs.renameSync(src, to); }
      catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.cpSync(src, to, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
    };
    move(file);
    move(dir);
    fs.writeFileSync(path.join(dest, 'origin.json'), JSON.stringify({ id, file, dir, deletedAt: new Date().toISOString() }, null, 2));
    this.hidden.delete(id);
    this._save();
    return dest;
  }
}
