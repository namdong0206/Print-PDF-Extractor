import * as Comlink from 'comlink';
import { parseNewspaperLayoutHybrid } from './hlaService';
import '@/lib/polyfills';

const workerApi = {
  async processLayout(page: any) {
    return await parseNewspaperLayoutHybrid(page);
  },
  async processText(textBlocks: any[]) {
    // Logic xử lý văn bản nặng ở đây
    return textBlocks;
  }
};

Comlink.expose(workerApi);
