/**
 * Minimal typed registry (ADR-017): the core exposes registries, learning
 * modules register entries. The core never imports modules directly.
 */
export interface RegistryItem {
  key: string;
}

export interface Registry<T extends RegistryItem> {
  readonly name: string;
  register(item: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  list(): T[];
}

export function createRegistry<T extends RegistryItem>(name: string): Registry<T> {
  const items = new Map<string, T>();
  return {
    name,
    register(item) {
      if (!item.key) throw new Error(`[${name}] item key is required`);
      if (items.has(item.key)) throw new Error(`[${name}] duplicate key "${item.key}"`);
      items.set(item.key, Object.freeze({ ...item }));
    },
    get: (key) => items.get(key),
    has: (key) => items.has(key),
    list: () => Array.from(items.values()),
  };
}
