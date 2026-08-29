self.onmessage = async ({ data }) => {
  try {
    const canvas = new OffscreenCanvas(data.bitmap.width, data.bitmap.height);
    canvas.getContext('2d').drawImage(data.bitmap, 0, 0);
    data.bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    self.postMessage({ id: data.id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error?.message || String(error) });
  }
};
