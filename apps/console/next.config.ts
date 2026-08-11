import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Console 通过 /api 代理访问 Registry，避免跨域
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
