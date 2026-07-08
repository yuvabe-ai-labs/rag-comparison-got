"use client";

import dynamic from "next/dynamic";
import type { Subgraph } from "@/lib/webTypes";

const Inner = dynamic(() => import("./KgSubgraphInner"), {
  ssr: false,
  loading: () => <p className="text-xs text-muted-foreground">Loading subgraph…</p>,
});

export default function KgSubgraph({ subgraph }: { subgraph: Subgraph }) {
  return <Inner subgraph={subgraph} />;
}
