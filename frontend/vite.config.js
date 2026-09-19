import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
    plugins: [react()],
    server: {
        host: "0.0.0.0",
        port: 3000,
        allowedHosts: [".internal", "localhost"],
        proxy: {
            "/api": { target: "http://localhost:8000", changeOrigin: true, timeout: 45000, proxyTimeout: 45000 },
        },
    },
    build: { outDir: "dist", sourcemap: true },
});
