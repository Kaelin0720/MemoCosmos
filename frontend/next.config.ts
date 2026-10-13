import type { NextConfig } from "next";

const config: NextConfig = {
  distDir: process.env.YIHE_TEST === "1" ? ".next-test" : ".next",
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
};

export default config;
