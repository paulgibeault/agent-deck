// public/menu.js — popover menu items, and the main menu's registry: each
// feature adds its own entry with registerMenuItem from its own module.
import { h, svgUse } from './events.js';

export function menuItem(icon, text, fn, { kbd = null, disabled = false, checked = null, cls = '', title = null } = {}) {
  return h('button', { type: 'button', class: `mm-i${cls ? ' ' + cls : ''}`, role: checked == null ? 'menuitem' : 'menuitemradio', 'aria-checked': checked == null ? null : String(checked),
    disabled: disabled || null, title, onclick: (e) => { e.currentTarget.closest('[popover]')?.hidePopover(); fn(); } },
    h('span', { class: 'mm-ic' }, icon), h('span', { class: 'mm-t' }, text),
    checked ? h('span', { class: 'mm-chk' }, svgUse('i-check', 12)) : kbd ? h('kbd', {}, kbd) : null);
}
export const menuSec = (text, extra = null) => h('div', { class: 'mm-sec' }, h('span', {}, text), extra);

const registered = [];
/**
 * Add an entry to the main menu's action list. Groups show by `order` (the
 * group's lowest; default 50, so features land between the core 'views' at 10
 * and 'backend' at 90), separated by a rule; items in a group in the order added.
 * `icon` is a sprite id (`i-…`) or a function returning a node; `disabled`
 * may be a function, read each time the menu draws. Returns a remover.
 */
export function registerMenuItem({ group, order = 50, icon, text, fn, kbd = null, disabled = false, cls = '', title = null }) {
  const item = { group, order, icon, text, fn, kbd, disabled, cls, title };
  registered.push(item);
  return () => { const i = registered.indexOf(item); if (i >= 0) registered.splice(i, 1); };
}

/** The registered entries as menu nodes: a rule before each group. */
export function menuItems() {
  const groups = new Map();
  for (const it of registered) groups.has(it.group) ? groups.get(it.group).push(it) : groups.set(it.group, [it]);
  const rank = (list) => Math.min(...list.map(it => it.order));
  return [...groups.values()].sort((a, b) => rank(a) - rank(b)).flatMap(list => [h('hr'), ...list.map(it => menuItem(
    typeof it.icon === 'function' ? it.icon() : svgUse(it.icon, 13), it.text, it.fn,
    { kbd: it.kbd, cls: it.cls, title: it.title, disabled: typeof it.disabled === 'function' ? it.disabled() : it.disabled }))]);
}
