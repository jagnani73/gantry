import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gantry/shared"],
  webpack: (config) => {
    // RainbowKit ≥2.2.9 optionally imports @x402/* client helpers; they're
    // optional peers we don't ship in M1 — alias them out so webpack resolves.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/core": false,
      "@x402/evm": false,
      "@x402/svm": false,
    };
    return config;
  },
};

export default nextConfig;
