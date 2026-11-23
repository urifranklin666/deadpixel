export const MAX_TREE_DEPTH = 8;

export function flattenLayers(list, out = []) {
  for (const layer of list) {
    out.push(layer);
    if (layer.type === 'group') flattenLayers(layer.children, out);
  }
  return out;
}

export function countLeaves(list) {
  let count = 0;
  for (const layer of list) count += layer.type === 'group' ? countLeaves(layer.children) : 1;
  return count;
}

export function locateLayer(list, id, parent = null, depth = 0) {
  for (let index = 0; index < list.length; index++) {
    const node = list[index];
    if (node.id === id) return { node, list, index, parent, depth };
    if (node.type === 'group') {
      const match = locateLayer(node.children, id, node, depth + 1);
      if (match) return match;
    }
  }
  return null;
}

export function fitsAtDepth(layer, depth) {
  if (depth > MAX_TREE_DEPTH) return false;
  if (layer.type !== 'group') return true;
  // DPX counts the child list of an empty group as a level too.
  return depth < MAX_TREE_DEPTH && layer.children.every(child => fitsAtDepth(child, depth + 1));
}

export function indexBeside(source, target, after) {
  const targetIndex = target.index - Number(source.list === target.list && source.index < target.index);
  return targetIndex + Number(after);
}

// Capture child lists independently so undo keeps the original node objects.
export function captureTopology(list) {
  return list.map(node => ({
    node,
    children: node.type === 'group' ? captureTopology(node.children) : null,
  }));
}

export function restoreTopology(snapshot) {
  return snapshot.map(({ node, children }) => {
    if (children) node.children = restoreTopology(children);
    return node;
  });
}
