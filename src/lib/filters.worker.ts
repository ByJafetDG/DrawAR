import { applyFilter, type FilterOptions } from './filters';

export type FilterRequest = { id: number; width: number; height: number; data: ArrayBuffer; opts: FilterOptions };

self.onmessage = (e: MessageEvent<FilterRequest>) => {
  const { id, width, height, data, opts } = e.data;
  applyFilter(new Uint8ClampedArray(data), width, height, opts);
  (self as unknown as Worker).postMessage({ id, data }, [data]);
};
