// public/todos.js: the agent's own task list, from TaskCreate/TaskUpdate or TodoWrite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTodos } from '../public/todos.js';

const tool = (seq, name, input, meta = undefined, extra = {}) => ({ seq, kind: 'tool', tool: { name, input, meta }, ...extra });

test('todos: none when the agent keeps no task list', () => {
  assert.equal(agentTodos([{ seq: 1, kind: 'text', text: 'hi' }, tool(2, 'Bash', { command: 'ls' })]), null);
});

test('todos: TaskCreate then TaskUpdate moves items across the columns; deleted ones go', () => {
  const t = agentTodos([
    tool(1, 'TaskCreate', { subject: 'Write the parser' }, { task: { id: '1' } }),
    tool(2, 'TaskCreate', { subject: 'Test it' }, { task: { id: '2' } }),
    tool(3, 'TaskCreate', { subject: 'Scratch idea' }),                 // result not in yet: numbered in order
    tool(4, 'TaskUpdate', { taskId: '1', status: 'completed' }),
    tool(5, 'TaskUpdate', { taskId: '2', status: 'in_progress', subject: 'Test the parser' }),
    tool(6, 'TaskUpdate', { taskId: '3', status: 'deleted' }),
    tool(7, 'TaskUpdate', { taskId: '9', status: 'completed' }),        // unknown: ignored
    tool(8, 'TaskCreate', { subject: 'a subagent\'s task' }, { task: { id: '1' } }, { parentId: 'agent-1' }),
  ]);
  assert.deepEqual(t.done.map(x => [x.text, x.seq]), [['Write the parser', 4]]);
  assert.deepEqual(t.doing.map(x => [x.text, x.seq]), [['Test the parser', 5]]);
  assert.deepEqual(t.todo, []);
});

test('todos: a TodoWrite replaces the whole list', () => {
  const t = agentTodos([
    tool(1, 'TodoWrite', { todos: [{ content: 'old', status: 'pending' }] }),
    tool(2, 'TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] }),
  ]);
  assert.deepEqual([t.done, t.doing, t.todo].map(l => l.map(x => x.text)), [['a'], ['b'], ['c']]);
});
