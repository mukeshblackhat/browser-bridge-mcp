#!/usr/bin/env node

/**
 * Browser Bridge MCP — CLI
 *
 * Commands:
 *   setup              Register MCP server with Claude Code (user scope)
 *   setup --scope project  Register in .mcp.json (project scope, git-committed)
 *   bookmarklet        Generate bookmarklet.html and open it
 *   snippet            Print client.js to stdout for console paste
 *   serve              Start the MCP server manually (for debugging)
 *   (default)          Start MCP server via stdio (used by Claude Code)
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CLIENT_PATH = join(ROOT, "src", "client.js");

const command = process.argv[2];

switch (command) {
  case "setup":
    setup();
    break;
  case "bookmarklet":
    bookmarklet();
    break;
  case "snippet":
    snippet();
    break;
  case "serve":
    serve();
    break;
  default:
    // Default: start the MCP server (this is what Claude Code invokes via stdio)
    await import("../src/server.mjs");
    break;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function setup() {
  const scopeFlag = process.argv.includes("--scope") && process.argv[process.argv.indexOf("--scope") + 1] === "project";

  if (scopeFlag) {
    // Project-scope: write .mcp.json
    const mcpConfig = {
      mcpServers: {
        "browser-bridge": {
          command: "npx",
          args: ["-y", "browser-bridge-mcp"],
        },
      },
    };

    const mcpPath = join(process.cwd(), ".mcp.json");
    let existing = {};
    try {
      existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
    } catch {
      // File doesn't exist yet
    }

    existing.mcpServers = existing.mcpServers || {};
    existing.mcpServers["browser-bridge"] = mcpConfig.mcpServers["browser-bridge"];

    writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
    console.log("✓ Added browser-bridge to .mcp.json (project scope)");
    console.log("  Commit .mcp.json so your team gets it automatically.");
  } else {
    // User-scope: use claude mcp add
    try {
      execSync(
        'claude mcp add browser-bridge --transport stdio -- npx -y browser-bridge-mcp',
        { stdio: "inherit" }
      );
      console.log("\n✓ Browser Bridge MCP registered with Claude Code");
      console.log("  Restart Claude Code to activate.");
    } catch (err) {
      console.error("Failed to register MCP server. Is Claude Code CLI installed?");
      console.error("  Try: npx browser-bridge-mcp setup --scope project");
      process.exit(1);
    }
  }
}

function bookmarklet() {
  const clientJs = readFileSync(CLIENT_PATH, "utf-8");

  // Basic minification: remove comments and extra whitespace
  const minified = clientJs
    .replace(/\/\*[\s\S]*?\*\//g, "")  // block comments
    .replace(/\/\/.*$/gm, "")          // line comments
    .replace(/\n\s*\n/g, "\n")         // empty lines
    .replace(/^\s+/gm, "")            // leading whitespace
    .trim();

  const bookmarkletUrl = `javascript:${encodeURIComponent(minified)}`;

  const html = `<!DOCTYPE html>
<html><head><title>Browser Bridge Bookmarklet</title></head>
<body style="font-family:system-ui;max-width:600px;margin:40px auto;padding:20px;">
  <h1>Browser Bridge</h1>
  <p>Drag this link to your bookmarks bar:</p>
  <p style="font-size:24px;padding:20px;background:#f0f0f0;border-radius:8px;text-align:center;">
    <a href="${bookmarkletUrl}" style="color:#059669;text-decoration:none;font-weight:bold;">
      Connect to Claude
    </a>
  </p>
  <p style="color:#666;">Click it on any page to connect that tab to Claude Code's Browser Bridge.</p>
  <h2>Or paste in console:</h2>
  <pre style="background:#1e1e1e;color:#d4d4d4;padding:16px;border-radius:8px;overflow-x:auto;font-size:12px;max-height:300px;overflow-y:auto;">${clientJs.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>
</body></html>`;

  const outPath = join(process.cwd(), "bookmarklet.html");
  writeFileSync(outPath, html);
  console.log(`✓ Bookmarklet written to ${outPath}`);
  console.log(`  (${bookmarkletUrl.length} characters)`);

  // Try to open in browser
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      execSync(`open "${outPath}"`);
    } else if (platform === "linux") {
      execSync(`xdg-open "${outPath}"`);
    } else if (platform === "win32") {
      execSync(`start "${outPath}"`);
    }
  } catch {
    console.log("  Open bookmarklet.html in your browser to use it.");
  }
}

function snippet() {
  const clientJs = readFileSync(CLIENT_PATH, "utf-8");
  process.stdout.write(clientJs);
}

async function serve() {
  console.log("Starting Browser Bridge MCP server...");
  console.log("  WebSocket: ws://127.0.0.1:8089");
  console.log("  HTTP (client.js): http://127.0.0.1:8090/client.js");
  console.log("  Press Ctrl+C to stop.\n");
  await import("../src/server.mjs");
}
