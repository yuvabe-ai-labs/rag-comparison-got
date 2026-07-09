import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Neo4j + OpenAI run server-side only.
  // The /api/ask route reads the vector store from data/vector at runtime via fs.
  // Next.js can't trace dynamic fs reads, so include those files in the function
  // bundle explicitly — otherwise they're missing from /var/task on Vercel.
  outputFileTracingIncludes: {
    "/api/ask": ["./data/vector/**", "./data/eval/**"],
  },
};

export default nextConfig;
