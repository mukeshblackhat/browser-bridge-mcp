/**
 * Next.js plugin: withBrowserBridge(nextConfig)
 * Auto-injects the browser bridge client script in development mode.
 * Complete no-op in production.
 */
export function withBrowserBridge(nextConfig = {}, options = {}) {
  if (process.env.NODE_ENV !== "development") return nextConfig;

  const httpPort = options.httpPort || 8090;

  return {
    ...nextConfig,
    webpack(config, ctx) {
      // Only inject on client-side build
      if (!ctx.isServer) {
        const { BannerPlugin } = ctx.webpack;
        config.plugins.push(
          new BannerPlugin({
            banner: `
              if (typeof window !== 'undefined' && !window.__browserBridge) {
                var s = document.createElement('script');
                s.src = 'http://127.0.0.1:${httpPort}/client.js';
                s.async = true;
                s.onerror = function() { console.debug('[BrowserBridge] MCP server not running'); };
                document.head.appendChild(s);
              }
            `,
            raw: true,
            entryOnly: true,
          })
        );
      }
      // Chain with user's webpack config if present
      if (typeof nextConfig.webpack === "function") {
        return nextConfig.webpack(config, ctx);
      }
      return config;
    },
  };
}
