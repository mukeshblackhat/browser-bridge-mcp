/**
 * Express/Connect middleware: browserBridgeMiddleware()
 * Injects the browser bridge client script into HTML responses.
 * For non-Next/Vite frameworks (Express, Fastify, etc.).
 */
export function browserBridgeMiddleware(options = {}) {
  const httpPort = options.httpPort || 8090;
  return (req, res, next) => {
    const originalEnd = res.end;
    res.end = function (chunk, ...args) {
      if (res.getHeader("content-type")?.includes("text/html") && chunk) {
        const html = chunk.toString();
        chunk = html.replace(
          "</body>",
          `<script src="http://127.0.0.1:${httpPort}/client.js" async></script></body>`
        );
      }
      originalEnd.call(this, chunk, ...args);
    };
    next();
  };
}
