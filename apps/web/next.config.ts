import type { NextConfig } from "next";
import "./src/env";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  agentRules: false,
  transpilePackages: ["@stackprep/shared"],
};

export default nextConfig;
