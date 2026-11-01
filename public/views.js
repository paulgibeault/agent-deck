// public/views.js — which view owns the main pane (#stream): `sessions`, the
// overview and session view app.js draws, or one a feature registers (Home).
// A view's mount(pane) shows it and unmount(pane) hides it again.
const views = new Map();
let current = null;
const pane = () => document.getElementById('stream');

export function registerView(name, { mount = () => {}, unmount = () => {} } = {}) {
  views.set(name, { mount, unmount });
}

/** Switch the main pane to `name`; already showing it, nothing happens. */
export function showView(name) {
  const next = views.get(name);
  if (!next) throw new Error(`unknown view: ${name}`);
  if (name === current) return;
  views.get(current)?.unmount(pane());
  current = name;
  next.mount(pane());
}

export const currentView = () => current;
