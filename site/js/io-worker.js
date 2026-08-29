importScripts('./vendor/fflate.js');

self.onmessage = ({ data }) => {
  try {
    const zipped = fflate.zipSync(data.files, { level: 6 });
    self.postMessage({ id: data.id, buffer: zipped.buffer }, [zipped.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error?.message || String(error) });
  }
};
