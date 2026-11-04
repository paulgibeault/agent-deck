// public/todos.js — the agent's own task list, read from its tool calls:
// TaskCreate / TaskUpdate (Claude Code's task tools) or a whole TodoWrite
// list. Exact and live between briefs, and free: no model call. No DOM.

const STATUS = { completed: 'done', in_progress: 'doing', pending: 'todo' };

/**
 * The newest task list in `events` (one session's, oldest first), or null
 * when the agent keeps none. Items: { id, text, status: done|doing|todo, seq }
 * where seq is the event that last changed the item.
 */
export function agentTodos(events) {
  const tasks = new Map();
  let created = 0;
  let seen = false;
  for (const e of events || []) {
    if (e.kind !== 'tool' || !e.tool || e.parentId) continue;
    const { name, input = {}, meta } = e.tool;
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      seen = true;
      tasks.clear();
      input.todos.forEach((t, i) => tasks.set(`w${i}`, { id: `w${i}`, text: t.content || t.activeForm || '', status: STATUS[t.status] || 'todo', seq: e.seq }));
    } else if (name === 'TaskCreate' && input.subject) {
      seen = true;
      // The id comes back in the result; until it does, Claude Code numbers them in order.
      const id = String(meta?.task?.id ?? ++created);
      created = Math.max(created, Number(id) || created);
      tasks.set(id, { id, text: input.subject, status: 'todo', seq: e.seq });
    } else if (name === 'TaskUpdate' && input.taskId != null) {
      const t = tasks.get(String(input.taskId));
      if (!t) continue;
      if (input.status === 'deleted') { tasks.delete(t.id); continue; }
      if (STATUS[input.status]) t.status = STATUS[input.status];
      if (input.subject) t.text = input.subject;
      t.seq = e.seq;
    }
  }
  if (!seen || !tasks.size) return null;
  const items = [...tasks.values()].filter(t => t.text);
  return { done: items.filter(t => t.status === 'done'), doing: items.filter(t => t.status === 'doing'), todo: items.filter(t => t.status === 'todo') };
}
