import { openDB } from 'idb';

const DB_NAME = 'NewspaperExtractionDB';
const DB_VERSION = 1;

export const initDB = async () => {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('layoutCache');
      db.createObjectStore('extractionCache');
    },
  });
};

export const getCache = async (storeName: 'layoutCache' | 'extractionCache', key: string) => {
  const db = await initDB();
  return db.get(storeName, key);
};

export const setCache = async (storeName: 'layoutCache' | 'extractionCache', key: string, value: any) => {
  const db = await initDB();
  return db.put(storeName, value, key);
};
