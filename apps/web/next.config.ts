import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:3001',
  },
};

export default nextConfig;
