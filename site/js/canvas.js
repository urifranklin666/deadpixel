export function makeCanvas(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return canvas;
}

export function copyCanvas(source) {
  const canvas = makeCanvas(source.width, source.height);
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
}
