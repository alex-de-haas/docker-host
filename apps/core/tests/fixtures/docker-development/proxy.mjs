import http from 'node:http';
http.createServer(async (_request, response) => {
  try {
    const upstream = await fetch(process.env.HOSTY_SERVICE_WEB_URL);
    const body = await upstream.text();
    response.writeHead(upstream.status);
    response.end(body);
  } catch (error) {
    console.error(error.message);
    response.writeHead(503);
    response.end('upstream unavailable');
  }
}).listen(Number(process.env.HOSTY_PORT_HTTP), '127.0.0.1');
