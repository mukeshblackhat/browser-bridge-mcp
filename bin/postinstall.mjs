#!/usr/bin/env node

/**
 * postinstall — auto-register browser-bridge in .mcp.json
 *
 * Runs after `npm install browser-bridge-mcp`. Adds the MCP server entry
 * to .mcp.json in the project root so Claude Code picks it up automatically.
 * Silently no-ops if anything goes wrong (CI, restricted environments, etc.).
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

try {
  // INIT_CWD is the directory where `npm install` was run (project root)
  const projectRoot = process.env.INIT_CWD;
  if (!projectRoot) process.exit(0);

  const mcpPath = join(projectRoot, ".mcp.json");

  let existing = {};
  try {
    existing = JSON.parse(readFileSync(mcpPath, "utf-8"));
  } catch {
    // File doesn't exist yet — we'll create it
  }

  // Don't overwrite if already configured
  if (existing.mcpServers?.["browser-bridge"]) {
    process.exit(0);
  }

  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers["browser-bridge"] = {
    command: "npx",
    args: ["-y", "browser-bridge-mcp"],
  };

  writeFileSync(mcpPath, JSON.stringify(existing, null, 2) + "\n");
  console.log("✓ browser-bridge-mcp: Added MCP server to .mcp.json");
  console.log("  Restart Claude Code to activate. Inject the client snippet in your browser.");
} catch {
  // Silently fail — don't break installs
}
