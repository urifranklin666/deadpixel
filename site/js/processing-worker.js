import { processFilterPixels, processSignalPixels } from './filters.js';

self.onmessage = ({ data }) => {
  try {
    let pixels;
    if (data.kind === 'filter') pixels = processFilterPixels(data.buffer, data.w, data.h, data.filterId, data.params);
    else if (data.kind === 'signal') pixels = processSignalPixels(data.buffer, data.w, data.h, data.effects, data.seed);
    else throw new Error('Unknown processing job');
    self.postMessage({ id: data.id, buffer: pixels.buffer }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ id: data.id, error: error?.message || String(error) });
  }
};
