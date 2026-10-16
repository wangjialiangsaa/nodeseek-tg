import { createServer, connect } from 'node:net';
import { once } from 'node:events';

export async function socksFixture(t, { username = 'fixture', password = 'test secret', reject = false } = {}) {
  const seen = []; const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const read = async n => { let data; while ((data = socket.read(n)) === null) await once(socket, 'readable'); return data; };
    (async () => {
      const greeting = await read(2); await read(greeting[1]); socket.write(Buffer.from([5, 2]));
      const auth = await read(2); const user = (await read(auth[1])).toString();
      const passLength = (await read(1))[0]; const pass = (await read(passLength)).toString();
      const accepted = !reject && user === username && pass === password;
      socket.write(Buffer.from([1, accepted ? 0 : 1])); if (!accepted) { socket.end(); return; }
      const request = await read(4);
      if (request[3] !== 3) throw new Error('Expected remote DNS hostname');
      const length = (await read(1))[0]; const host = (await read(length)).toString();
      const port = (await read(2)).readUInt16BE(); seen.push({ user, host, port });
      const target = connect(port, '127.0.0.1'); sockets.add(target);
      target.on('close', () => sockets.delete(target)); target.on('error', () => socket.destroy());
      await once(target, 'connect'); socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.pipe(target); target.pipe(socket);
    })().catch(() => socket.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(r => server.close(r)); });
  return { seen, url: `socks5://${encodeURIComponent(username)}:${encodeURIComponent(password)}@127.0.0.1:${server.address().port}` };
}
