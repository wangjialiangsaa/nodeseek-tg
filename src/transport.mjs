import { fetch, ProxyAgent } from 'undici';
import { openProxy } from './proxy.mjs';

export function createTransport() {
  const agents = new Map();
  async function makeAgent(proxy) {
    const bridge = await openProxy(proxy);
    try {
      const agent = new ProxyAgent(bridge.url);
      return { agent, async close() { try { await agent.close(); } finally { await bridge.close(); } } };
    } catch (error) { await bridge.close(); throw error; }
  }
  async function request(url, options = {}) {
    const { proxy, ...init } = options;
    if (proxy) {
      if (!agents.has(proxy)) {
        if (agents.size >= 8) {
          const [oldest, agent] = agents.entries().next().value;
          agents.delete(oldest); await (await agent).close();
        }
        agents.set(proxy, makeAgent(proxy));
      }
      try { init.dispatcher = (await agents.get(proxy)).agent; }
      catch (error) { agents.delete(proxy); throw error; }
    }
    return fetch(url, init);
  }
  return { request, async close() { const entries = [...agents.values()]; agents.clear(); await Promise.all(entries.map(async entry => { const result = await entry.catch(() => null); await result?.close(); })); } };
}
