import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_PREFIX = 'rivium_ab_testing_';

/** The SDK's keys in AsyncStorage, all under one prefix. */
export const Storage = {
  /** The key as stored, prefix included (what getAllKeys returns). */
  fullKey(key: string): string {
    return `${STORAGE_PREFIX}${key}`;
  },

  async getItem(key: string): Promise<string | null> {
    try {
      return await AsyncStorage.getItem(`${STORAGE_PREFIX}${key}`);
    } catch {
      return null;
    }
  },

  async setItem(key: string, value: string): Promise<void> {
    try {
      await AsyncStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
    } catch {
      // Storage full or unavailable
    }
  },

  async removeItem(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {
      // Ignore
    }
  },

  /** Only this SDK's keys, prefix included. */
  async getAllKeys(): Promise<string[]> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      return keys.filter((k) => k.startsWith(STORAGE_PREFIX));
    } catch {
      return [];
    }
  },

  async multiGet(keys: string[]): Promise<[string, string | null][]> {
    try {
      const results = await AsyncStorage.multiGet(keys.map((k) => `${STORAGE_PREFIX}${k}`));
      return results.map(([, value], i) => [keys[i], value] as [string, string | null]);
    } catch {
      return keys.map((k) => [k, null] as [string, string | null]);
    }
  },

  /** Takes full keys, as returned by getAllKeys. */
  async multiRemove(keys: string[]): Promise<void> {
    try {
      await AsyncStorage.multiRemove(keys);
    } catch {
      // Ignore
    }
  },
};
