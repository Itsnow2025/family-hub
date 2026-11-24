import type { NextConfig } from "next";

// Every page in Family Hub is personal and signed in, so nothing is
// prerendered or cached across people. The classic dynamic model keeps that
// simple: a page that reads the session renders per request.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
