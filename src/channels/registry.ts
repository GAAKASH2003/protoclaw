import type { ChannelAdapter } from './types.js';
const adapters = new Map<string, ChannelAdapter>();

export function registerChannelAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.channelType.toLowerCase(), adapter);
}

export function unregisterChannelAdapter(adapterOrType: string | ChannelAdapter): void {
  const type = typeof adapterOrType === 'string' ? adapterOrType : adapterOrType.channelType;
  adapters.delete(type.toLowerCase());
}

export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  return adapters.get(channelType.toLowerCase());
}

export function listChannelAdapters(): ChannelAdapter[] {
  return Array.from(adapters.values());
}

export function clearChannelAdapters(): void {
  adapters.clear();
}
