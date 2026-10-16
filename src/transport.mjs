import { fetch, ProxyAgent } from 'undici';

export function createTransport() {
  const agents = new Map();
  async function request(url, options = {}) {
    const { proxy, ...init } = options;
    if (proxy) {
      if (!agents.has(proxy)) {
        if (agents.size >= 8) {
          const [oldest, agent] = agents.entries().next().value;
          agents.delete(oldest); await agent.close();
        }
        agents.set(proxy, new ProxyAgent(proxy));
      }
      init.dispatcher = agents.get(proxy);
    }
    return fetch(url, init);
  }
  return { request, async close() { await Promise.all([...agents.values()].map(agent => agent.close())); agents.clear(); } };
}
