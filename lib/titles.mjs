// lib/titles.mjs — the pilot's own session titles. Kept in deck state as an
// override, never written into the transcript; applied where summaries are
// made (SessionIndex.titleOf), so the rail, hover card, Home and wrap-up all
// see it. A streamed (ACP) session's deck record is renamed too: that name is
// what its registry entry reports and what a resume starts it with.

export const TITLE_MAX = 200;

/** A title worth storing: one line, trimmed, capped; null for nothing. */
export function cleanOverride(t) {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, TITLE_MAX) : null;
}

const PRUNE_MS = 60 * 60_000;

export class Titles {
  constructor({ deck, index = null, agents = null }) {
    this.store = deck.ns('titles');
    this.index = index;
    this.agents = agents;
    if (index) index.titleOf = (id) => this.get(id);
    agents?.on('proc', ({ id, proc }) => {
      // A resumed or restarted streamed session starts under the pilot's name, not the agent's.
      const t = this.get(id);
      if (t) this._rename(id, t);
      // A resume the agent gives a fresh id: the title follows it (AgentManager re-keys on init).
      proc?.on?.('init', ({ sessionId } = {}) => {
        if (!sessionId || sessionId === id || this.get(sessionId) || !this.get(id)) return;
        this.store.set(sessionId, this.get(id)); this.store.set(id, undefined);
      });
    });
    // Titles of sessions that are gone (deleted, or aged out of the agent's list) are dropped:
    // now (the index has scanned the disk by the time this is made) and every hour.
    if (index) { this.prune(); setInterval(() => this.prune(), PRUNE_MS).unref?.(); }
  }

  get(id) { return this.store.get(id, null); }

  /** Drop the titles of sessions neither the index nor the deck's agent records know. Returns how many. */
  prune() {
    const known = (id) => this.index.files?.has(id) || this.agents?.harnesses?.has(id) || this.agents?.agents?.has(id);
    const gone = this.store.keys().filter(id => !known(id));
    for (const id of gone) this.store.set(id, undefined);
    return gone.length;
  }

  /** Set (or with an empty title, clear) a session's title; returns the override now in force. */
  set(id, title) {
    const t = cleanOverride(title);
    this.store.set(id, t ?? undefined);
    this._rename(id, t);
    this.index?.refresh?.(id);
    return t;
  }

  /**
   * A streamed session's deck name follows the title. Its own name (first
   * prompt, or what its agent called it) is kept on the record before the
   * first rename, and also seeded into the index, so the streamed events
   * never copy the pilot's title in as the session's own. Clearing restores it.
   */
  _rename(id, t) {
    const a = this.agents?.agents?.get(id);
    if (!a || this.agents.drivers?.[a.harness]?.caps.events !== 'stream') return;
    if (!Object.hasOwn(a, 'ownName')) a.ownName = a.name;
    const meta = this.index?.loaded?.get(id)?.state.meta;
    if (meta && !meta.title && a.ownName) meta.title = a.ownName;
    a.name = t || a.ownName || meta?.title || null;
  }
}
