// Templates are generated from the storefront's own inline typography. Merchant
// input is always text. Keep unchanged text in its original emphasis runs.
export function formattedText(template, value) {
  const runs = [];
  function collect(parts) {
    for (const part of parts) {
      if (typeof part === 'string') runs.push(part);
      else collect(part.slice(1));
    }
  }
  collect(template);
  const original = runs.join('');
  if (original === value) return template;
  if (!original || !value) return [value];

  let start = 0, oldEnd = original.length, newEnd = value.length;
  while (start < oldEnd && start < newEnd && original[start] === value[start]) start++;
  while (oldEnd > start && newEnd > start && original[oldEnd - 1] === value[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const inserted = value.slice(start, newEnd);
  let offset = 0, written = false, index = 0;
  const edited = runs.map((run, i) => {
    const end = offset + run.length;
    const before = run.slice(0, Math.max(0, start - offset));
    const after = run.slice(Math.max(0, oldEnd - offset));
    const atChange = !written && (end > start || i === runs.length - 1);
    if (atChange) written = true;
    offset = end;
    return before + (atChange ? inserted : '') + after;
  });

  function replace(parts) {
    const result = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        const text = edited[index++];
        if (text) result.push(text);
      } else if (part[0] === 'br') {
        if (edited.slice(0, index).some(Boolean) && edited.slice(index).some(Boolean)) result.push(part);
      } else {
        const children = replace(part.slice(1));
        if (children.length) result.push([part[0], ...children]);
      }
    }
    return result;
  }
  return replace(template);
}

export function setFormattedText(node, parts) {
  function append(parent, children) {
    for (const part of children) {
      if (typeof part === 'string') parent.append(part);
      else {
        const element = node.ownerDocument.createElement(part[0]);
        append(element, part.slice(1));
        parent.append(element);
      }
    }
  }
  const fragment = node.ownerDocument.createDocumentFragment();
  append(fragment, parts);
  node.replaceChildren(fragment);
}
