/**
 * Browser Bridge Client
 *
 * Paste this entire script into your browser console (or load as bookmarklet)
 * to connect the current tab to Claude Code's Browser Bridge MCP server.
 *
 * What it captures (automatically pushed to Claude):
 *   - All console output (log, warn, error, info, debug)
 *   - All fetch and XHR network requests with status, timing, headers, body
 *   - JavaScript errors and unhandled promise rejections
 *   - Page navigation changes
 *
 * What Claude can pull on-demand:
 *   - localStorage / sessionStorage
 *   - Cookies
 *   - Page info (URL, title, viewport, etc.)
 *   - Execute arbitrary JS
 *   - Redux state
 *   - React Query cache
 *   - Performance metrics
 *   - DOM snapshots
 *
 * Configuration:
 *   window.__BRIDGE_PORT = 8089;           // WebSocket port (default 8089)
 *   window.__BRIDGE_LABEL = "my-tab";      // Label for this tab (default: auto from URL)
 *   window.__BRIDGE_CAPTURE_BODIES = true; // Capture request/response bodies (default true)
 *   window.__BRIDGE_MAX_BODY_SIZE = 10000; // Max body size in chars (default 10000)
 */
(function () {
  "use strict";

  // Prevent double-injection
  if (window.__browserBridge) {
    console.log("[Bridge] Already connected. Use window.__browserBridge.disconnect() to reconnect.");
    return;
  }

  const PORT_START = window.__BRIDGE_PORT || 8089;
  const PORT_RANGE = 10; // scan ports 8089-8098
  const CAPTURE_BODIES = window.__BRIDGE_CAPTURE_BODIES !== false;
  const MAX_BODY_SIZE = window.__BRIDGE_MAX_BODY_SIZE || 10000;

  let ws = null;
  let reconnectTimer = null;
  let connected = false;
  let focused = false;
  let tabId = null;
  let badge = null;
  let activePort = null;

  // Auto-generate label from URL if not set
  function getLabel() {
    if (window.__BRIDGE_LABEL) return window.__BRIDGE_LABEL;
    try {
      const u = new URL(location.href);
      const path = u.pathname === "/" ? "" : u.pathname.slice(0, 30);
      return `${u.hostname}${path}`;
    } catch {
      return location.href.slice(0, 40);
    }
  }

  // ---------------------------------------------------------------------------
  // Connection indicator badge
  // ---------------------------------------------------------------------------

  function createBadge() {
    badge = document.createElement("div");
    badge.id = "__bridge-badge";
    badge.style.cssText = `
      position: fixed; bottom: 8px; right: 8px; z-index: 999999;
      padding: 4px 10px; border-radius: 12px; font-size: 11px;
      font-family: system-ui, sans-serif; font-weight: 600;
      color: white; cursor: pointer; transition: all 0.3s;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2); user-select: none;
    `;
    badge.addEventListener("click", () => {
      badge.style.display = badge.style.display === "none" ? "block" : "none";
    });
    document.body.appendChild(badge);
    updateBadge();
  }

  function updateBadge() {
    if (!badge) return;
    if (!connected) {
      badge.style.background = "linear-gradient(135deg, #ef4444, #dc2626)";
      badge.textContent = "⏳ Bridge Reconnecting...";
    } else if (focused) {
      badge.style.background = "linear-gradient(135deg, #3b82f6, #2563eb)";
      badge.textContent = "🎯 Claude Focused";
      badge.title = `Tab ID: ${tabId}\nThis tab is Claude's active target`;
    } else {
      badge.style.background = "linear-gradient(135deg, #6b7280, #4b5563)";
      badge.textContent = "🔗 Bridge Connected";
      badge.title = `Tab ID: ${tabId}\nConnected but not focused. Claude is watching another tab.`;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return;
    }

    // If we already found a working port, connect directly
    if (activePort) {
      connectToPort(activePort);
      return;
    }

    // Scan ports to find the server
    scanPorts();
  }

  function scanPorts() {
    let found = false;
    let checked = 0;

    for (let i = 0; i < PORT_RANGE; i++) {
      const port = PORT_START + i;
      const testWs = new WebSocket(`ws://127.0.0.1:${port}`);

      testWs.onopen = () => {
        if (!found) {
          found = true;
          activePort = port;
          testWs.close();
          connectToPort(port);
        } else {
          testWs.close();
        }
      };

      testWs.onerror = () => {
        checked++;
        if (checked >= PORT_RANGE && !found) {
          scheduleReconnect();
        }
      };

      testWs.onclose = () => {
        if (!found) {
          checked++;
          if (checked >= PORT_RANGE) {
            scheduleReconnect();
          }
        }
      };
    }
  }

  function connectToPort(port) {
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
    } catch {
      activePort = null;
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      connected = true;
      activePort = port;
      updateBadge();
      console.log(`[Bridge] Connected to Claude Code on port ${port}`);

      // Send initial page info
      sendPageInfo();
    };

    ws.onclose = () => {
      connected = false;
      updateBadge();
      // Reset activePort so next reconnect scans again
      activePort = null;
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after this
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "request") {
          handleServerRequest(msg);
        } else if (msg.type === "tab_id") {
          tabId = msg.tabId;
          updateBadge();
        } else if (msg.type === "focus_state") {
          focused = msg.focused;
          updateBadge();
          if (focused) {
            originalConsole.log(`[Bridge] This tab is now Claude's focused target (${tabId})`);
          } else {
            originalConsole.log("[Bridge] This tab is no longer focused");
          }
        }
      } catch {
        // ignore
      }
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function sendPageInfo() {
    send({
      type: "page_info",
      url: location.href,
      title: document.title,
      label: getLabel(),
      userAgent: navigator.userAgent,
    });
  }

  // ---------------------------------------------------------------------------
  // Console hooking
  // ---------------------------------------------------------------------------

  const originalConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };

  function hookConsole() {
    ["log", "warn", "error", "info", "debug"].forEach((level) => {
      console[level] = function (...args) {
        // Call original
        originalConsole[level](...args);

        // Skip our own bridge messages
        if (args[0] && typeof args[0] === "string" && args[0].startsWith("[Bridge]")) return;

        send({
          type: "console",
          level,
          args: args.map(serializeArg),
          timestamp: Date.now(),
          stack: level === "error" ? new Error().stack : undefined,
        });
      };
    });
  }

  function serializeArg(arg) {
    if (arg === undefined) return "undefined";
    if (arg === null) return null;
    if (typeof arg === "string") return arg;
    if (typeof arg === "number" || typeof arg === "boolean") return arg;
    if (arg instanceof Error) return { __type: "Error", message: arg.message, stack: arg.stack };
    if (arg instanceof HTMLElement) return { __type: "HTMLElement", tag: arg.tagName, id: arg.id, className: arg.className };
    try {
      const str = JSON.stringify(arg);
      return str.length > MAX_BODY_SIZE ? JSON.parse(str.slice(0, MAX_BODY_SIZE) + '..."') : JSON.parse(str);
    } catch {
      return String(arg);
    }
  }

  // ---------------------------------------------------------------------------
  // Fetch hooking
  // ---------------------------------------------------------------------------

  const originalFetch = window.fetch.bind(window);

  function hookFetch() {
    window.fetch = async function (input, init = {}) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init.method || (input instanceof Request ? input.method : "GET");
      const startTime = Date.now();
      let requestBody = null;

      if (CAPTURE_BODIES && init.body) {
        requestBody = await readBody(init.body);
      }

      try {
        const response = await originalFetch(input, init);
        const duration = Date.now() - startTime;

        // Clone to read body without consuming
        let responseBody = null;
        if (CAPTURE_BODIES) {
          try {
            const clone = response.clone();
            const text = await clone.text();
            responseBody = text.length > MAX_BODY_SIZE ? text.slice(0, MAX_BODY_SIZE) + "...[truncated]" : text;
          } catch {
            responseBody = "[could not read response body]";
          }
        }

        send({
          type: "network",
          method: method.toUpperCase(),
          url,
          status: response.status,
          statusText: response.statusText,
          duration,
          requestHeaders: init.headers ? serializeHeaders(init.headers) : null,
          responseHeaders: serializeHeaders(response.headers),
          requestBody,
          responseBody,
          timestamp: startTime,
          initiator: "fetch",
        });

        return response;
      } catch (err) {
        send({
          type: "network",
          method: method.toUpperCase(),
          url,
          status: 0,
          error: err.message,
          duration: Date.now() - startTime,
          requestBody,
          timestamp: startTime,
          initiator: "fetch",
        });
        throw err;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // XHR hooking
  // ---------------------------------------------------------------------------

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;
  const XHRSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  function hookXHR() {
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__bridge = { method: method.toUpperCase(), url: String(url), headers: {}, startTime: null };
      return XHROpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__bridge) {
        this.__bridge.headers[name] = value;
      }
      return XHRSetHeader.call(this, name, value);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this.__bridge) {
        this.__bridge.startTime = Date.now();
        if (CAPTURE_BODIES && body) {
          this.__bridge.requestBody = typeof body === "string" ? body.slice(0, MAX_BODY_SIZE) : "[non-string body]";
        }

        this.addEventListener("loadend", () => {
          const b = this.__bridge;
          if (!b) return;

          let responseBody = null;
          if (CAPTURE_BODIES) {
            try {
              const text = this.responseText;
              responseBody = text && text.length > MAX_BODY_SIZE ? text.slice(0, MAX_BODY_SIZE) + "...[truncated]" : text;
            } catch {
              responseBody = "[could not read response]";
            }
          }

          send({
            type: "network",
            method: b.method,
            url: b.url,
            status: this.status,
            statusText: this.statusText,
            duration: Date.now() - b.startTime,
            requestHeaders: Object.keys(b.headers).length > 0 ? b.headers : null,
            responseHeaders: parseXHRHeaders(this.getAllResponseHeaders()),
            requestBody: b.requestBody || null,
            responseBody,
            timestamp: b.startTime,
            initiator: "xhr",
          });
        });
      }

      return XHRSend.call(this, body);
    };
  }

  function parseXHRHeaders(raw) {
    if (!raw) return null;
    const headers = {};
    raw.trim().split("\r\n").forEach((line) => {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return headers;
  }

  // ---------------------------------------------------------------------------
  // Error hooking
  // ---------------------------------------------------------------------------

  function hookErrors() {
    window.addEventListener("error", (event) => {
      send({
        type: "error",
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error?.stack || null,
        timestamp: Date.now(),
      });
    });

    window.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      send({
        type: "error",
        message: reason?.message || String(reason),
        stack: reason?.stack || null,
        filename: null,
        lineno: null,
        colno: null,
        timestamp: Date.now(),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Navigation tracking
  // ---------------------------------------------------------------------------

  function hookNavigation() {
    // Track pushState/replaceState
    const origPushState = history.pushState.bind(history);
    const origReplaceState = history.replaceState.bind(history);

    history.pushState = function (...args) {
      origPushState(...args);
      setTimeout(sendPageInfo, 0);
    };

    history.replaceState = function (...args) {
      origReplaceState(...args);
      setTimeout(sendPageInfo, 0);
    };

    window.addEventListener("popstate", () => setTimeout(sendPageInfo, 0));
  }

  // ---------------------------------------------------------------------------
  // Server request handlers (pull queries from Claude)
  // ---------------------------------------------------------------------------

  function handleServerRequest(msg) {
    const { id, action, params } = msg;

    const handlers = {
      getLocalStorage: () => {
        if (params.key) {
          const val = localStorage.getItem(params.key);
          return { key: params.key, value: tryParseJson(val) };
        }
        const all = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          all[key] = tryParseJson(localStorage.getItem(key));
        }
        return all;
      },

      getSessionStorage: () => {
        if (params.key) {
          const val = sessionStorage.getItem(params.key);
          return { key: params.key, value: tryParseJson(val) };
        }
        const all = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          all[key] = tryParseJson(sessionStorage.getItem(key));
        }
        return all;
      },

      getCookies: () => {
        return document.cookie.split(";").reduce((acc, cookie) => {
          const [key, ...rest] = cookie.trim().split("=");
          if (key) acc[key.trim()] = decodeURIComponent(rest.join("="));
          return acc;
        }, {});
      },

      getPageInfo: () => ({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scrollPosition: { x: window.scrollX, y: window.scrollY },
        documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        activeElement: document.activeElement ? {
          tag: document.activeElement.tagName,
          id: document.activeElement.id,
          className: document.activeElement.className,
        } : null,
      }),

      executeJs: () => {
        try {
          // eslint-disable-next-line no-eval
          const result = eval(params.code);
          return { success: true, result: serializeArg(result) };
        } catch (err) {
          return { success: false, error: err.message, stack: err.stack };
        }
      },

      getReduxState: () => {
        // Try multiple ways to access Redux store
        let state = null;

        // Method 1: __REDUX_STORE__
        if (window.__REDUX_STORE__) {
          state = window.__REDUX_STORE__.getState();
        }
        // Method 2: __store__ (common pattern)
        else if (window.__store__) {
          state = window.__store__.getState();
        }
        // Method 3: Try to find it via Redux DevTools
        else {
          try {
            const devTools = window.__REDUX_DEVTOOLS_EXTENSION__;
            if (devTools) {
              state = "[Redux DevTools detected but cannot access state directly. Expose store as window.__REDUX_STORE__ for direct access.]";
            }
          } catch {
            // ignore
          }
        }

        if (!state) {
          return { error: "Redux store not found. Add `window.__REDUX_STORE__ = store` in your store setup for direct access." };
        }

        if (params.path) {
          const parts = params.path.split(".");
          let current = state;
          for (const part of parts) {
            if (current == null) break;
            current = current[part];
          }
          return { path: params.path, value: current };
        }

        return state;
      },

      getReactQueryCache: () => {
        // Try to find React Query client
        const queryClient = window.__REACT_QUERY_CLIENT__;

        if (!queryClient) {
          return { error: "React Query client not found. Add `window.__REACT_QUERY_CLIENT__ = queryClient` in your QueryClientProvider setup." };
        }

        try {
          const queryCache = queryClient.getQueryCache();
          const queries = queryCache.getAll().map((query) => ({
            queryKey: query.queryKey,
            state: query.state.status,
            dataUpdatedAt: query.state.dataUpdatedAt ? new Date(query.state.dataUpdatedAt).toISOString() : null,
            isStale: query.isStale(),
            data: query.state.data,
            error: query.state.error?.message || null,
          }));

          if (params.query_key_contains) {
            return queries.filter((q) =>
              JSON.stringify(q.queryKey).includes(params.query_key_contains)
            );
          }

          return queries;
        } catch (err) {
          return { error: `Failed to read React Query cache: ${err.message}` };
        }
      },

      getPerformance: () => {
        const nav = performance.getEntriesByType("navigation")[0];
        const paint = performance.getEntriesByType("paint");
        const resources = performance.getEntriesByType("resource").slice(-20);

        return {
          navigation: nav ? {
            domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
            loadComplete: Math.round(nav.loadEventEnd - nav.startTime),
            ttfb: Math.round(nav.responseStart - nav.startTime),
            domInteractive: Math.round(nav.domInteractive - nav.startTime),
          } : null,
          paint: paint.map((p) => ({ name: p.name, time: Math.round(p.startTime) })),
          memory: performance.memory ? {
            usedJSHeapSize: `${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)}MB`,
            totalJSHeapSize: `${(performance.memory.totalJSHeapSize / 1048576).toFixed(1)}MB`,
            jsHeapSizeLimit: `${(performance.memory.jsHeapSizeLimit / 1048576).toFixed(1)}MB`,
          } : null,
          recentResources: resources.map((r) => ({
            name: r.name.split("/").pop(),
            type: r.initiatorType,
            duration: `${Math.round(r.duration)}ms`,
            size: r.transferSize ? `${(r.transferSize / 1024).toFixed(1)}KB` : null,
          })),
        };
      },

      getDomSnapshot: () => {
        const el = document.querySelector(params.selector || "body");
        if (!el) return { error: `Element not found: ${params.selector}` };

        function traverse(node, depth) {
          if (depth > (params.max_depth || 5)) return { tag: "...", truncated: true };
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            return text ? text : null;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return null;

          const result = {
            tag: node.tagName.toLowerCase(),
            ...(node.id ? { id: node.id } : {}),
            ...(node.className && typeof node.className === "string" ? { class: node.className } : {}),
          };

          // Include key attributes
          const importantAttrs = ["href", "src", "type", "name", "value", "placeholder", "role", "aria-label", "data-testid"];
          importantAttrs.forEach((attr) => {
            const val = node.getAttribute(attr);
            if (val) result[attr] = val;
          });

          const children = [];
          for (const child of node.childNodes) {
            const c = traverse(child, depth + 1);
            if (c) children.push(c);
          }
          if (children.length > 0) result.children = children;

          return result;
        }

        return traverse(el, 0);
      },
    };

    const handler = handlers[action];
    if (!handler) {
      send({ type: "response", id, data: { error: `Unknown action: ${action}` } });
      return;
    }

    try {
      const data = handler();
      send({ type: "response", id, data });
    } catch (err) {
      send({ type: "response", id, data: { error: err.message } });
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function tryParseJson(str) {
    if (str === null || str === undefined) return str;
    try {
      return JSON.parse(str);
    } catch {
      return str;
    }
  }

  function serializeHeaders(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) {
      const obj = {};
      headers.forEach((value, key) => { obj[key] = value; });
      return obj;
    }
    if (typeof headers === "object") return { ...headers };
    return null;
  }

  async function readBody(body) {
    if (!body) return null;
    if (typeof body === "string") return body.slice(0, MAX_BODY_SIZE);
    if (body instanceof FormData) {
      const obj = {};
      body.forEach((val, key) => { obj[key] = val instanceof File ? `[File: ${val.name}]` : val; });
      return obj;
    }
    if (body instanceof URLSearchParams) return body.toString().slice(0, MAX_BODY_SIZE);
    if (body instanceof Blob) {
      try {
        const text = await body.text();
        return text.slice(0, MAX_BODY_SIZE);
      } catch {
        return "[Blob body]";
      }
    }
    return "[unknown body type]";
  }

  // ---------------------------------------------------------------------------
  // Initialize
  // ---------------------------------------------------------------------------

  hookConsole();
  hookFetch();
  hookXHR();
  hookErrors();
  hookNavigation();

  // Wait for body before creating badge
  if (document.body) {
    createBadge();
  } else {
    document.addEventListener("DOMContentLoaded", createBadge);
  }

  connect();

  // Public API
  window.__browserBridge = {
    disconnect: () => {
      if (ws) ws.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (badge) badge.remove();

      // Restore originals
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.debug = originalConsole.debug;
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = XHROpen;
      XMLHttpRequest.prototype.send = XHRSend;
      XMLHttpRequest.prototype.setRequestHeader = XHRSetHeader;

      window.__browserBridge = null;
      originalConsole.log("[Bridge] Disconnected and hooks restored.");
    },
    isConnected: () => connected,
    reconnect: () => { if (ws) ws.close(); connect(); },
  };
})();
