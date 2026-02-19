# browser-bridge-mcp

Give [Claude Code](https://docs.anthropic.com/en/docs/claude-code) direct access to your browser — console logs, network requests, JS errors, storage, DOM, and more.

## How it works

```
Browser <──WebSocket──> MCP Server <──stdio──> Claude Code
```

A small client script runs in your browser tab, hooks into console, fetch, XHR, and error events, and streams everything to an MCP server that Claude Code can query.

## Quick Start

### 1. Install

```bash
npm install -D browser-bridge-mcp
```

### 2. Register with Claude Code

```bash
# User scope (just you)
npx browser-bridge-mcp setup

# Project scope (whole team via .mcp.json)
npx browser-bridge-mcp setup --scope project
```

### 3. Connect your app (pick one)

**Next.js** — add to `next.config.mjs` (or `.ts`):

```js
import { withBrowserBridge } from 'browser-bridge-mcp/next';

// Wrap your config — no-op in production
export default withBrowserBridge(nextConfig);
```

**Vite** — add to `vite.config.js`:

```js
import { browserBridge } from 'browser-bridge-mcp/vite';

export default defineConfig({
  plugins: [browserBridge()],
});
```

**Any page** (bookmarklet / console paste):

```bash
npx browser-bridge-mcp bookmarklet   # generates clickable bookmarklet HTML
npx browser-bridge-mcp snippet       # prints client.js to stdout
```

### 4. Use it

Restart Claude Code, run your dev server, done. Claude can now see everything in your browser.

## What Claude Can See

| Tool | Description |
|------|-------------|
| `browser_get_console_logs` | Console output (log, warn, error, info, debug) |
| `browser_get_network_requests` | Fetch/XHR with status, timing, headers, body |
| `browser_get_errors` | JS errors and unhandled promise rejections |
| `browser_get_local_storage` | Read localStorage |
| `browser_get_session_storage` | Read sessionStorage |
| `browser_get_cookies` | Read cookies |
| `browser_get_page_info` | URL, title, viewport, scroll position |
| `browser_execute_js` | Run arbitrary JS in the page |
| `browser_get_redux_state` | Redux store state |
| `browser_get_react_query_cache` | React Query cache |
| `browser_get_performance` | Page load timing, memory, resources |
| `browser_get_dom_snapshot` | DOM tree snapshot (CSS selector targeted) |
| `browser_list_connections` | List connected tabs |
| `browser_focus_tab` | Focus a specific tab for queries |
| `browser_clear_all` | Clear all event buffers |

## Multi-Tab Support

Connect multiple browser tabs simultaneously. Use `browser_focus_tab` to switch which tab Claude is actively querying. The focused tab gets a blue badge; other connected tabs get a gray badge.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_BRIDGE_PORT` | `8089` | WebSocket server port |
| `BROWSER_BRIDGE_HTTP_PORT` | `8090` | HTTP server port (serves client.js) |

Browser-side (set before client.js loads):

```js
window.__BRIDGE_PORT = 8089;           // WebSocket port
window.__BRIDGE_LABEL = "my-tab";      // Custom tab label
window.__BRIDGE_CAPTURE_BODIES = true; // Capture request/response bodies
window.__BRIDGE_MAX_BODY_SIZE = 10000; // Max body size in chars
```

## Framework Plugins

All plugins are **dev-only** and **no-op in production**.

### Next.js

```js
import { withBrowserBridge } from 'browser-bridge-mcp/next';
export default withBrowserBridge(nextConfig);
// Composes with other wrappers:
// export default withSentryConfig(withBrowserBridge(nextConfig), sentryOptions);
```

### Vite

```js
import { browserBridge } from 'browser-bridge-mcp/vite';
export default defineConfig({ plugins: [browserBridge()] });
```

### Express / Connect

```js
import { browserBridgeMiddleware } from 'browser-bridge-mcp/middleware';
app.use(browserBridgeMiddleware());
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `npx browser-bridge-mcp setup` | Register MCP server with Claude Code |
| `npx browser-bridge-mcp setup --scope project` | Add to `.mcp.json` (team-wide) |
| `npx browser-bridge-mcp bookmarklet` | Generate bookmarklet HTML file |
| `npx browser-bridge-mcp snippet` | Print client.js to stdout |
| `npx browser-bridge-mcp serve` | Start server manually (debugging) |

## License

MIT
