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
