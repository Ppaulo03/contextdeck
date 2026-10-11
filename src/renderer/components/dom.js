// Tiny DOM helpers shared by the components. Text is always set with textContent, so names coming
// from Herdr or Git (branches, subjects, workspace labels) can never be interpreted as HTML.
export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Sets an aria/data attribute only when it changes (avoids needless style recalculation).
export function setAttr(node, name, value) {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}
