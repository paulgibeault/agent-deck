// public/launch.js — the New session dialog's registry: a feature adds its own
// section and its own fields to the launch without editing app.js.
//   registerLaunchSection({
//     slot: 'cwd' | 'prompt',         // after the folder field, or above the prompt
//     open(el, ctx),                  // the dialog opened: fill `el` (yours alone); ctx = { cwd(), selected }
//     cwdChanged(cwd, el),            // the folder field changed (typed, picked, or set by another feature)
//     collect(body) => patch,         // before /api/launch: return fields to merge in (or throw to stop with a message)
//     launched(state, body),          // it started
//   })
// Any of them may be async. A section that renders nothing takes no space.
// The server side is lib/launch.mjs: hooks that read those fields.
const sections = [];

/** Add a section. Returns a function that removes it. */
export function registerLaunchSection(sec) {
  sections.push(sec);
  return () => { const i = sections.indexOf(sec); if (i >= 0) sections.splice(i, 1); };
}

/** The dialog opened: each section gets a fresh element in its slot. */
const els = new Map();   // section -> its element, while the dialog is open

// One feature's bug, sync or async, must not keep the dialog from working.
function guard(fn) {
  try { Promise.resolve(fn()).catch(e => console.error('launch section:', e)); }
  catch (e) { console.error('launch section:', e); }
}

export function launchOpen(slots, ctx) {
  for (const box of Object.values(slots)) box.replaceChildren();
  els.clear();
  for (const sec of sections) {
    const el = document.createElement('div');
    el.className = 'ns-sec';
    (slots[sec.slot] || slots.prompt).append(el);
    els.set(sec, el);
    if (sec.open) guard(() => sec.open(el, ctx));
  }
}

/** The folder field changed. */
export function launchCwdChanged(cwd) {
  for (const sec of sections) if (sec.cwdChanged) guard(() => sec.cwdChanged(cwd, els.get(sec)));
}

/** Merge every section's fields into the launch body, in order; a section may throw to stop the launch. */
export async function launchCollect(body) {
  for (const sec of sections) if (sec.collect) body = { ...body, ...((await sec.collect(body)) || {}) };
  return body;
}

export function launchDone(st, body) {
  for (const sec of sections) if (sec.launched) guard(() => sec.launched(st, body));
}
