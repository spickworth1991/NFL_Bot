// health-server.js
import http from 'node:http';

const port = process.env.PORT || 3000;

// very small HTTP server so Koyeb health checks & pingers have something to hit
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  // optional: basic homepage
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('bot online');
});

server.listen(port, '0.0.0.0', () => {
  console.log('health on', port);
});
