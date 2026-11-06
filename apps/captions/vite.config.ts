import devServer from "@hono/vite-dev-server"
import type { IncomingMessage } from "node:http"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import {
  clipIdFromPath,
  injectClipAgentDiscovery,
  wantsAgentJson,
} from "./api/lib/clip-agent-context"
import { disableRequestTimeouts, incomingAls } from "./api/lib/incoming"

// https://vite.dev/config/
export default defineConfig({
  // The export renderer is opened directly from dist/public via file://.
  // Relative build assets work there and when the main app is served at /.
  base: "./",
  plugins: [
    {
      name: "incoming-als",
      configureServer(server) {
        const apply = () => {
          if (server.httpServer) {
            disableRequestTimeouts(
              server.httpServer as Parameters<typeof disableRequestTimeouts>[0],
            )
          }
        }
        apply()
        server.httpServer?.on("listening", apply)
        server.middlewares.use(
          (req: IncomingMessage, _res, next) => {
            incomingAls.run(req, next)
          },
        )
        server.middlewares.use((req: IncomingMessage, _res, next) => {
          const id = clipIdFromPath((req.url ?? "").split("?")[0] ?? "")
          if (!id) return next()
          if (!wantsAgentJson(String(req.headers.accept ?? ""))) return next()
          req.url = `/api/agent-context.json?id=${encodeURIComponent(id)}`
          next()
        })
      },
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          const originalUrl =
            "originalUrl" in ctx && typeof ctx.originalUrl === "string"
              ? ctx.originalUrl
              : ctx.path
          const id = clipIdFromPath(originalUrl.split("?")[0] ?? "")
          if (!id) return html
          return injectClipAgentDiscovery(html, "", id)
        },
      },
    },
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/).*$/] }),
    inspectAttr(), react()],
  server: {
    // Keep local development well clear of the 3000/3001 range. Failing on
    // a collision is intentional: Vite must never silently roll to 3001.
    port: 43127,
    strictPort: true,
  },
  optimizeDeps: {
    // pre-bundling breaks the transcription worker: any dep-cache
    // invalidation aborts the worker's module import mid-flight (workers
    // can't do Vite's full-reload recovery), and esbuild mangles the
    // library's wasm asset URLs. Serve it as native ESM instead.
    exclude: ["@huggingface/transformers"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.resolve(__dirname, "index.html"),
        render: path.resolve(__dirname, "render.html"),
      },
    },
  },
});
