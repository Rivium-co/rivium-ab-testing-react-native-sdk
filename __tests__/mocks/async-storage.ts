/** AsyncStorage for tests: a Map that outlives a reload of the SDK module. */
const scope = globalThis as any;

export function storageMap(): Map<string, string> {
  if (!scope.__riviumTestStorage) scope.__riviumTestStorage = new Map<string, string>();
  return scope.__riviumTestStorage;
}

export function clearStorage(): void {
  scope.__riviumTestStorage = new Map<string, string>();
}

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return storageMap().has(key) ? storageMap().get(key)! : null;
  },
  async setItem(key: string, value: string): Promise<void> {
    storageMap().set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    storageMap().delete(key);
  },
  async getAllKeys(): Promise<string[]> {
    return [...storageMap().keys()];
  },
  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    return keys.map((key) => [key, storageMap().has(key) ? storageMap().get(key)! : null]);
  },
  async multiRemove(keys: string[]): Promise<void> {
    keys.forEach((key) => storageMap().delete(key));
  },
};

export default AsyncStorage;
