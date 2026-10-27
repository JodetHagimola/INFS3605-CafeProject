import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["*.app.github.dev"],
  experimental: {
    serverActions: {
      ...(isDevelopment && {
        allowedOrigins: ["localhost:3000", "*.app.github.dev"],
      }),
    },
  },
};

export default nextConfig;
