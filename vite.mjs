/**
 * Vite plugin: browserBridge()
 * Auto-injects the browser bridge client script in development mode.
 * Production builds skip this entirely (apply: 'serve').
 */
export function browserBridge(options = {}) {
  const httpPort = options.httpPort || 8090;
  return {
    name: "browser-bridge-mcp",
    apply: "serve", // dev only
    transformIndexHtml(html) {
      return html.replace(
        "</body>",
        `<script src="http://127.0.0.1:${httpPort}/client.js" async onerror="console.debug('[BrowserBridge] MCP server not running')"></script></body>`
      );
    },
  };
}
