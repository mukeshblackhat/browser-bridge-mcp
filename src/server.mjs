#!/usr/bin/env node

/**
 * Browser Bridge MCP Server
 *
 * Gives Claude Code direct access to browser state:
 * - Console logs (log, warn, error, info, debug)
 * - Network requests (fetch/XHR with status, timing, headers, body)
 * - JS errors and unhandled rejections
 * - localStorage, sessionStorage, cookies
 * - Page info (URL, title, DOM queries)
 * - Execute arbitrary JS in the page
 *
 * Architecture:
 *   Browser <--WebSocket--> This Server <--stdio/MCP--> Claude Code
 *
 * The browser runs a small client script (client.js) that:
 *   1. Hooks console, fetch, XHR, errors
 *   2. Pushes events to this server via WebSocket
 *   3. Responds to pull-queries (storage, execute JS, etc.)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { createServer } from "http";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const WS_PORT_START = parseInt(process.env.BROWSER_BRIDGE_PORT || "8089", 10);
const HTTP_PORT_START = parseInt(process.env.BROWSER_BRIDGE_HTTP_PORT || "8090", 10);
const PORT_RANGE = 10; // try up to 10 consecutive ports
const MAX_BUFFER = 2000; // max items to keep in each buffer
const QUERY_TIMEOUT_MS = 5000;

// Actual ports (set after binding)
let wsPort = null;
let httpPort = null;

// ---------------------------------------------------------------------------
// State - buffered events from browser
// ---------------------------------------------------------------------------

/** @type {Array<Object>} */
const consoleLogs = [];
/** @type {Array<Object>} */
const networkRequests = [];
/** @type {Array<Object>} */
const jsErrors = [];

// Connected browser tabs: tabId -> { ws, url, title, label, connectedAt, userAgent }
const connections = new Map();

// The "focused" tab - all queries and event filtering default to this tab
let focusedTabId = null;

// Pending request/response pairs for pull-queries
const pendingRequests = new Map();
let requestIdCounter = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bufferPush(buffer, item) {
  buffer.push(item);
  while (buffer.length > MAX_BUFFER) buffer.shift();
}

function generateTabId() {
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Resolve which tab to use: explicit tab_id > focused tab > only-connected tab.
 */
function resolveTab(tabId = null) {
  if (tabId) return connections.get(tabId) || null;
  if (focusedTabId) return connections.get(focusedTabId) || null;
  // If exactly one tab connected, use it implicitly
  if (connections.size === 1) return connections.values().next().value;
  return null;
}

/**
 * Send a query to a connected browser tab and wait for its response.
 */
function queryBrowser(action, params = {}, tabId = null) {
  return new Promise((resolve, reject) => {
    const conn = resolveTab(tabId);

    if (!conn || conn.ws.readyState !== 1) {
      const hint = connections.size === 0
        ? "No browser tab connected. Paste the client.js snippet in your browser console first."
        : connections.size > 1 && !focusedTabId
          ? `${connections.size} tabs connected but none focused. Use browser_focus_tab to pick one.`
          : "Target tab not found or disconnected.";
      reject(new Error(hint));
      return;
    }

    const id = `req-${++requestIdCounter}`;
    pendingRequests.set(id, resolve);

    conn.ws.send(JSON.stringify({ type: "request", id, action, params }));

    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`Browser query timed out after ${QUERY_TIMEOUT_MS}ms`));
      }
    }, QUERY_TIMEOUT_MS);
  });
}

function formatToolResult(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function formatError(err) {
  return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
}

// ---------------------------------------------------------------------------
// HTTP Server - serves client.js to browser
// ---------------------------------------------------------------------------

const CLIENT_JS = readFileSync(new URL("./client.js", import.meta.url), "utf-8");

const httpServer = createServer((req, res) => {
  if (req.url === "/client.js") {
    res.writeHead(200, {
      "Content-Type": "application/javascript",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache",
    });
    res.end(CLIENT_JS);
  } else {
    res.writeHead(404);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// Port binding helpers — try a range of ports to avoid EADDRINUSE
// ---------------------------------------------------------------------------

function tryListen(server, startPort, host) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const attempt = () => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && port < startPort + PORT_RANGE - 1) {
          port++;
          attempt();
        } else if (err.code === "EADDRINUSE") {
          reject(new Error(`All ports ${startPort}-${port} in use`));
        } else {
          reject(err);
        }
      });
      server.listen(port, host, () => resolve(port));
    };
    attempt();
  });
}

function tryListenWss(startPort, host) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const attempt = () => {
      const wss = new WebSocketServer({ port, host });
      wss.on("error", (err) => {
        if (err.code === "EADDRINUSE" && port < startPort + PORT_RANGE - 1) {
          port++;
          attempt();
        } else if (err.code === "EADDRINUSE") {
          reject(new Error(`All ports ${startPort}-${port} in use`));
        } else {
          reject(err);
        }
      });
      wss.on("listening", () => resolve({ wss, port }));
    };
    attempt();
  });
}

// Start WebSocket server
let wss;
try {
  const result = await tryListenWss(WS_PORT_START, "127.0.0.1");
  wss = result.wss;
  wsPort = result.port;
  process.stderr.write(`[browser-bridge] WebSocket server listening on ws://127.0.0.1:${wsPort}\n`);
} catch (err) {
  process.stderr.write(`[browser-bridge] FATAL: Could not bind WebSocket — ${err.message}\n`);
  process.exit(1);
}

// Start HTTP server (non-fatal if it fails)
try {
  httpPort = await tryListen(httpServer, HTTP_PORT_START, "127.0.0.1");
  process.stderr.write(`[browser-bridge] HTTP server serving client.js on http://127.0.0.1:${httpPort}/client.js\n`);
} catch (err) {
  process.stderr.write(`[browser-bridge] HTTP server disabled — ${err.message} (MCP still works)\n`);
}

/**
 * Notify a browser tab whether it is the focused tab.
 */
function notifyFocusState(tabId, isFocused) {
  const conn = connections.get(tabId);
  if (conn && conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify({ type: "focus_state", focused: isFocused }));
  }
}

wss.on("connection", (ws, req) => {
  const tabId = generateTabId();
  const connInfo = {
    ws,
    url: "",
    title: "",
    label: "",
    userAgent: "",
    connectedAt: Date.now(),
  };
  connections.set(tabId, connInfo);
  process.stderr.write(`[browser-bridge] Browser tab connected: ${tabId}\n`);

  // Send the tab its assigned ID so it can display it
  ws.send(JSON.stringify({ type: "tab_id", tabId }));

  // If this is the only tab and nothing is focused, auto-focus it
  if (connections.size === 1 && !focusedTabId) {
    focusedTabId = tabId;
    notifyFocusState(tabId, true);
    process.stderr.write(`[browser-bridge] Auto-focused tab: ${tabId}\n`);
  }

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      handleBrowserMessage(tabId, msg);
    } catch {
      // ignore malformed messages
    }
  });

  ws.on("close", () => {
    const wasFocused = focusedTabId === tabId;
    connections.delete(tabId);
    process.stderr.write(`[browser-bridge] Browser tab disconnected: ${tabId}\n`);

    // If the focused tab disconnected, auto-focus the remaining tab (if only one left)
    if (wasFocused) {
      focusedTabId = null;
      if (connections.size === 1) {
        const [remainingId] = connections.keys();
        focusedTabId = remainingId;
        notifyFocusState(remainingId, true);
        process.stderr.write(`[browser-bridge] Auto-focused remaining tab: ${remainingId}\n`);
      }
    }
  });

  ws.on("error", () => {
    connections.delete(tabId);
  });
});

function handleBrowserMessage(tabId, msg) {
  const conn = connections.get(tabId);

  switch (msg.type) {
    case "console":
      bufferPush(consoleLogs, {
        tabId,
        level: msg.level,
        args: msg.args,
        timestamp: msg.timestamp,
        stack: msg.stack || null,
        url: conn?.url || "",
      });
      break;

    case "network":
      bufferPush(networkRequests, {
        tabId,
        method: msg.method,
        url: msg.url,
        status: msg.status,
        statusText: msg.statusText,
        duration: msg.duration,
        requestHeaders: msg.requestHeaders,
        responseHeaders: msg.responseHeaders,
        requestBody: msg.requestBody,
        responseBody: msg.responseBody,
        error: msg.error || null,
        timestamp: msg.timestamp,
        initiator: msg.initiator || null,
        pageUrl: conn?.url || "",
      });
      break;

    case "error":
      bufferPush(jsErrors, {
        tabId,
        message: msg.message,
        stack: msg.stack,
        filename: msg.filename,
        lineno: msg.lineno,
        colno: msg.colno,
        timestamp: msg.timestamp,
        url: conn?.url || "",
      });
      break;

    case "page_info":
      if (conn) {
        conn.url = msg.url || conn.url;
        conn.title = msg.title || conn.title;
        conn.label = msg.label || conn.label;
        conn.userAgent = msg.userAgent || conn.userAgent;
      }
      break;

    case "response":
      // Response to a pull-query
      const resolver = pendingRequests.get(msg.id);
      if (resolver) {
        resolver(msg.data);
        pendingRequests.delete(msg.id);
      }
      break;
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "browser-bridge",
  version: "1.0.0",
});

// --- Tool: List connected browser tabs ---
server.tool(
  "browser_list_connections",
  "List all connected browser tabs. Shows which tab is focused (the default target for all queries).",
  {},
  async () => {
    const tabs = [...connections.entries()].map(([id, c]) => ({
      tabId: id,
      focused: id === focusedTabId,
      label: c.label || null,
      url: c.url,
      title: c.title,
      connectedAt: new Date(c.connectedAt).toISOString(),
    }));
    if (tabs.length === 0) {
      return formatToolResult("No browser tabs connected. Paste the client.js snippet in your browser console to connect.");
    }
    return formatToolResult({ focusedTabId, tabs });
  }
);

// --- Tool: Focus a specific tab ---
server.tool(
  "browser_focus_tab",
  "Focus a specific browser tab. The focused tab becomes the default target for ALL queries, and only its console/network/error events are shown. Use browser_list_connections first to see available tabs.",
  {
    tab_id: z.string().optional().describe("Exact tab ID to focus"),
    url_contains: z.string().optional().describe("Focus the first tab whose URL contains this string"),
    label: z.string().optional().describe("Focus the tab with this label"),
    unfocus: z.boolean().default(false).describe("Set to true to clear focus (queries will require explicit tab_id)"),
  },
  async ({ tab_id, url_contains, label, unfocus }) => {
    // Unfocus
    if (unfocus) {
      const prevId = focusedTabId;
      focusedTabId = null;
      if (prevId) notifyFocusState(prevId, false);
      return formatToolResult("Focus cleared. Queries will now require an explicit tab_id, or will use the only connected tab.");
    }

    // Find the target tab
    let targetId = null;

    if (tab_id) {
      if (connections.has(tab_id)) {
        targetId = tab_id;
      } else {
        return formatError(new Error(`Tab ${tab_id} not found. Use browser_list_connections to see available tabs.`));
      }
    } else if (url_contains) {
      for (const [id, c] of connections) {
        if (c.url.includes(url_contains)) {
          targetId = id;
          break;
        }
      }
      if (!targetId) {
        return formatError(new Error(`No tab found with URL containing "${url_contains}".`));
      }
    } else if (label) {
      for (const [id, c] of connections) {
        if (c.label === label) {
          targetId = id;
          break;
        }
      }
      if (!targetId) {
        return formatError(new Error(`No tab found with label "${label}".`));
      }
    } else {
      return formatError(new Error("Provide one of: tab_id, url_contains, or label."));
    }

    // Switch focus
    const prevId = focusedTabId;
    focusedTabId = targetId;

    if (prevId && prevId !== targetId) notifyFocusState(prevId, false);
    notifyFocusState(targetId, true);

    const conn = connections.get(targetId);
    return formatToolResult({
      message: "Tab focused successfully",
      focusedTab: {
        tabId: targetId,
        label: conn.label || null,
        url: conn.url,
        title: conn.title,
      },
    });
  }
);

// --- Tool: Get console logs ---
server.tool(
  "browser_get_console_logs",
  "Get captured browser console logs. Captures log, warn, error, info, debug output from the connected browser tab.",
  {
    level: z.enum(["all", "log", "warn", "error", "info", "debug"]).default("all").describe("Filter by log level"),
    limit: z.number().default(50).describe("Max number of logs to return"),
    since: z.number().optional().describe("Only logs after this Unix timestamp (ms)"),
    search: z.string().optional().describe("Filter logs containing this string"),
    clear: z.boolean().default(false).describe("Clear log buffer after reading"),
  },
  async ({ level, limit, since, search, clear }) => {
    let logs = [...consoleLogs];
    // Filter to focused tab if one is set
    if (focusedTabId) logs = logs.filter((l) => l.tabId === focusedTabId);
    if (level !== "all") logs = logs.filter((l) => l.level === level);
    if (since) logs = logs.filter((l) => l.timestamp > since);
    if (search) logs = logs.filter((l) => JSON.stringify(l.args).includes(search));
    logs = logs.slice(-limit);
    if (clear) consoleLogs.length = 0;

    if (logs.length === 0) {
      return formatToolResult("No console logs captured yet.");
    }

    // Format for readability
    const formatted = logs.map((l) => ({
      level: l.level,
      message: l.args,
      time: new Date(l.timestamp).toISOString(),
      ...(l.stack ? { stack: l.stack } : {}),
    }));
    return formatToolResult(formatted);
  }
);

// --- Tool: Get network requests ---
server.tool(
  "browser_get_network_requests",
  "Get captured network requests (fetch and XHR) with method, URL, status, timing, headers, and response body.",
  {
    method: z.string().optional().describe("Filter by HTTP method (GET, POST, etc.)"),
    status_min: z.number().optional().describe("Min status code (e.g. 400 for errors)"),
    status_max: z.number().optional().describe("Max status code"),
    url_contains: z.string().optional().describe("Filter by URL substring"),
    limit: z.number().default(30).describe("Max results"),
    failed_only: z.boolean().default(false).describe("Only show failed/error requests"),
    include_body: z.boolean().default(false).describe("Include request and response bodies"),
    clear: z.boolean().default(false).describe("Clear buffer after reading"),
  },
  async ({ method, status_min, status_max, url_contains, limit, failed_only, include_body, clear }) => {
    let reqs = [...networkRequests];
    // Filter to focused tab if one is set
    if (focusedTabId) reqs = reqs.filter((r) => r.tabId === focusedTabId);
    if (method) reqs = reqs.filter((r) => r.method?.toUpperCase() === method.toUpperCase());
    if (status_min) reqs = reqs.filter((r) => r.status >= status_min);
    if (status_max) reqs = reqs.filter((r) => r.status <= status_max);
    if (url_contains) reqs = reqs.filter((r) => r.url?.includes(url_contains));
    if (failed_only) reqs = reqs.filter((r) => (r.status && r.status >= 400) || r.error);
    reqs = reqs.slice(-limit);
    if (clear) networkRequests.length = 0;

    if (reqs.length === 0) {
      return formatToolResult("No network requests captured yet.");
    }

    const formatted = reqs.map((r) => {
      const entry = {
        method: r.method,
        url: r.url,
        status: r.status,
        statusText: r.statusText,
        duration: r.duration ? `${r.duration}ms` : null,
        time: new Date(r.timestamp).toISOString(),
        ...(r.error ? { error: r.error } : {}),
      };
      if (include_body) {
        entry.requestBody = r.requestBody;
        entry.responseBody = r.responseBody;
        entry.requestHeaders = r.requestHeaders;
        entry.responseHeaders = r.responseHeaders;
      }
      return entry;
    });
    return formatToolResult(formatted);
  }
);

// --- Tool: Get JS errors ---
server.tool(
  "browser_get_errors",
  "Get captured JavaScript errors and unhandled promise rejections from the browser.",
  {
    limit: z.number().default(20).describe("Max errors to return"),
    since: z.number().optional().describe("Only errors after this timestamp (ms)"),
    clear: z.boolean().default(false).describe("Clear error buffer after reading"),
  },
  async ({ limit, since, clear }) => {
    let errs = [...jsErrors];
    // Filter to focused tab if one is set
    if (focusedTabId) errs = errs.filter((e) => e.tabId === focusedTabId);
    if (since) errs = errs.filter((e) => e.timestamp > since);
    errs = errs.slice(-limit);
    if (clear) jsErrors.length = 0;

    if (errs.length === 0) {
      return formatToolResult("No JavaScript errors captured.");
    }

    const formatted = errs.map((e) => ({
      message: e.message,
      stack: e.stack,
      file: e.filename,
      line: e.lineno,
      col: e.colno,
      time: new Date(e.timestamp).toISOString(),
    }));
    return formatToolResult(formatted);
  }
);

// --- Tool: Get localStorage ---
server.tool(
  "browser_get_local_storage",
  "Read localStorage from the connected browser tab. Returns all keys or a specific key.",
  {
    key: z.string().optional().describe("Specific key to read. If omitted, returns all keys and values."),
    tab_id: z.string().optional().describe("Specific tab ID (from browser_list_connections)"),
  },
  async ({ key, tab_id }) => {
    try {
      const data = await queryBrowser("getLocalStorage", { key }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get sessionStorage ---
server.tool(
  "browser_get_session_storage",
  "Read sessionStorage from the connected browser tab.",
  {
    key: z.string().optional().describe("Specific key to read. If omitted, returns all."),
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ key, tab_id }) => {
    try {
      const data = await queryBrowser("getSessionStorage", { key }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get cookies ---
server.tool(
  "browser_get_cookies",
  "Read cookies from the connected browser tab.",
  {
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ tab_id }) => {
    try {
      const data = await queryBrowser("getCookies", {}, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get page info ---
server.tool(
  "browser_get_page_info",
  "Get current page info: URL, title, document ready state, viewport size, and selected element.",
  {
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ tab_id }) => {
    try {
      const data = await queryBrowser("getPageInfo", {}, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Execute JavaScript ---
server.tool(
  "browser_execute_js",
  "Execute arbitrary JavaScript code in the connected browser tab and return the result. Use this to inspect DOM, check variables, test selectors, read app state, etc.",
  {
    code: z.string().describe("JavaScript code to execute in the browser page context"),
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ code, tab_id }) => {
    try {
      const data = await queryBrowser("executeJs", { code }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get Redux state ---
server.tool(
  "browser_get_redux_state",
  "Get the current Redux store state from the browser (works if the app uses Redux with window.__REDUX_DEVTOOLS_EXTENSION__ or window.__store__).",
  {
    path: z.string().optional().describe("Dot-notation path into state, e.g. 'user.profile'. If omitted, returns full state."),
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ path, tab_id }) => {
    try {
      const data = await queryBrowser("getReduxState", { path }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get React Query cache ---
server.tool(
  "browser_get_react_query_cache",
  "Get React Query cache state from the browser. Shows cached queries with their status, data, and staleness.",
  {
    query_key_contains: z.string().optional().describe("Filter by query key substring"),
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ query_key_contains, tab_id }) => {
    try {
      const data = await queryBrowser("getReactQueryCache", { query_key_contains }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Get performance metrics ---
server.tool(
  "browser_get_performance",
  "Get browser performance metrics: page load timing, memory usage, resource loading waterfall.",
  {
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ tab_id }) => {
    try {
      const data = await queryBrowser("getPerformance", {}, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Take DOM snapshot ---
server.tool(
  "browser_get_dom_snapshot",
  "Get a snapshot of the DOM. Can target a specific CSS selector or get the full body.",
  {
    selector: z.string().default("body").describe("CSS selector to snapshot (default: body)"),
    max_depth: z.number().default(5).describe("Max depth for DOM tree traversal"),
    tab_id: z.string().optional().describe("Specific tab ID"),
  },
  async ({ selector, max_depth, tab_id }) => {
    try {
      const data = await queryBrowser("getDomSnapshot", { selector, max_depth }, tab_id);
      return formatToolResult(data);
    } catch (err) {
      return formatError(err);
    }
  }
);

// --- Tool: Clear all buffers ---
server.tool(
  "browser_clear_all",
  "Clear all captured console logs, network requests, and errors.",
  {},
  async () => {
    consoleLogs.length = 0;
    networkRequests.length = 0;
    jsErrors.length = 0;
    return formatToolResult("All buffers cleared.");
  }
);

// ---------------------------------------------------------------------------
// Start MCP server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write("[browser-bridge] MCP server connected via stdio\n");
