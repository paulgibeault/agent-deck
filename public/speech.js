// public/speech.js — the read-aloud queue and the text rules for the ear.
// Pure: no DOM, no Node APIs, so the page and the tests share it. The player
// (public/narration.js) owns voices, audio and the pane.

// ------------------------------------------------------------ text

const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St|No|Fig)\.$/i;
const MAX_CHUNK = 320;

/**
 * Cut a block of text into sentence-sized chunks: [{ start, end }] offsets
 * into `text`, whitespace trimmed off both ends. A sentence ends at . ! ? or
 * … followed by space, unless the word is an abbreviation; one longer than
 * MAX_CHUNK is cut again at a comma, semicolon or space.
 */
export function splitSentences(text) {
  const s = String(text ?? '');
  const out = [];
  const push = (a, b) => {
    while (a < b && /\s/.test(s[a])) a++;
    while (b > a && /\s/.test(s[b - 1])) b--;
    if (b <= a) return;
    while (b - a > MAX_CHUNK) {
      const win = s.slice(a, a + MAX_CHUNK);
      let cut = Math.max(win.lastIndexOf(', '), win.lastIndexOf('; '), win.lastIndexOf(': '));
      if (cut < MAX_CHUNK / 3) cut = win.lastIndexOf(' ');
      if (cut < MAX_CHUNK / 3) cut = MAX_CHUNK - 1;
      out.push({ start: a, end: a + cut + 1 });
      a += cut + 1;
      while (a < b && /\s/.test(s[a])) a++;
    }
    if (b > a) out.push({ start: a, end: b });
  };
  let start = 0;
  const re = /[.!?…]+["')\]]*(?=\s)|\n{2,}/g;
  let m;
  while ((m = re.exec(s))) {
    const end = m.index + m[0].length;
    if (m[0][0] !== '\n' && ABBREV.test(s.slice(Math.max(start, end - 8), end))) continue;
    push(start, end);
    start = end;
  }
  push(start, s.length);
  return out;
}

const URL_RE = /\bhttps?:\/\/([^/\s)]+)[^\s)]*/g;
// A path with at least one slash and a final segment: say only the final segment.
const PATH_RE = /(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?|\b[\w.@+-]+(?:\/[\w.@+-]+){2,}/g;

/** What a voice should say for a piece of on-screen text. */
export function forSpeech(text) {
  return String(text ?? '')
    .replace(URL_RE, (_, host) => host.replace(/^www\./, ''))
    .replace(PATH_RE, (p) => p.replace(/\/$/, '').split('/').pop())
    .replace(/[*_`#>|~]+/g, ' ')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "code block, 14 lines" */
export function codeSay(text) {
  const n = String(text ?? '').replace(/\n$/, '').split('\n').length;
  return n > 1 ? `code block, ${n} lines` : 'code';
}

/** The first sentence the voice says: who, why, and how much was passed over. */
export function introFor(item, skipped = 0) {
  const who = item.title || 'A session';
  const lead = {
    said: `${who}.`,
    brief: `${who}, brief.`,
    needs: item.permission ? `${who} needs your permission.` : `${who} is asking.`,
    error: `${who} hit an error.`,
    done: `${who} finished.`,
  }[item.kind] || `${who}.`;
  return skipped ? `${lead} ${skipped} earlier ${skipped === 1 ? 'update' : 'updates'} skipped.` : lead;
}

// ------------------------------------------------------------ queue

/**
 * Items: { id, sessionId, kind, priority: 'high'|'normal', manual?, … }.
 * First in, first out; high-priority items go ahead of normal ones, behind
 * earlier high ones. Nothing here interrupts what is playing: the player
 * decides that.
 */
export class SpeechQueue {
  constructor() { this.items = []; }
  get length() { return this.items.length; }

  push(item) {
    if (item.priority === 'high') {
      const i = this.items.findIndex(x => x.priority !== 'high' && !x.resume);
      this.items.splice(i < 0 ? this.items.length : i, 0, item);
    } else this.items.push(item);
    return item;
  }

  /** Put an interrupted item back at the very front, to go on from `at` (a chunk index). */
  resume(item, at) { this.items.unshift({ ...item, resume: true, at }); }

  /**
   * Take the next item. With `latest`, an item whose session has newer items
   * of the same kind waiting is replaced by the newest of them, and the rest
   * are dropped: { item, skipped }. A resumed item is never collapsed.
   */
  next({ latest = true } = {}) {
    const head = this.items.shift();
    if (!head) return null;
    if (!latest || head.resume || head.manual) return { item: head, skipped: head.skipped || 0 };
    const same = (x) => !x.manual && !x.resume && x.sessionId === head.sessionId && x.kind === head.kind;
    const later = this.items.filter(same);
    if (!later.length) return { item: head, skipped: head.skipped || 0 };
    this.items = this.items.filter(x => !same(x));
    return { item: later.at(-1), skipped: later.length + (head.skipped || 0) };
  }

  /** Drop everything (or everything matching `pred`). */
  clear(pred = null) { this.items = pred ? this.items.filter(x => !pred(x)) : []; }
}
