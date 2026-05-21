import { IDexAdapter } from './adapter-interface';

const dexRegistry = new Map<string, () => IDexAdapter>();

export function registerDex(name: string, factory: () => IDexAdapter): void {
  if (dexRegistry.has(name)) {
    console.warn(`[DexRegistry] DEX '${name}' already registered, overwriting`);
  }
  dexRegistry.set(name, factory);
  console.log(`[DexRegistry] Registered DEX: ${name}`);
}

export function createDexAdapter(dexName: string): IDexAdapter {
  const factory = dexRegistry.get(dexName);
  if (!factory) {
    const available = [...dexRegistry.keys()].join(', ') || 'none';
    throw new Error(`Unknown DEX: '${dexName}'. Available: ${available}`);
  }
  return factory();
}

export function getAvailableDexes(): string[] {
  return [...dexRegistry.keys()];
}
