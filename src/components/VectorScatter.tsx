"use client";

import dynamic from "next/dynamic";
import type { ScatterData } from "@/lib/webTypes";

const Inner = dynamic(() => import("./VectorScatterInner"), {
  ssr: false,
  loading: () => <p className="text-xs text-muted-foreground">Loading scatter…</p>,
});

export default function VectorScatter({ data }: { data: ScatterData }) {
  return <Inner data={data} />;
}
