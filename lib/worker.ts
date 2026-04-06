import * as Comlink from 'comlink';
import { analyzeLayoutData } from './hlaService';

const workerApi = {
  async processLayoutHybrid(textItems: any[], vectorData: any, pageWidth: number, pageHeight: number) {
    return await analyzeLayoutData(textItems, vectorData, pageWidth, pageHeight);
  },
  async processText(textBlocks: any[]) {
    return textBlocks;
  }
};

Comlink.expose(workerApi);
