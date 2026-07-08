"use client";

import dynamic from "next/dynamic";
import type { ComparisonResult } from "@/lib/webTypes";

const Inner = dynamic(() => import("./RubricBarsInner"), {
  ssr: false,
  loading: () => <p className="text-xs text-muted-foreground">Loading rubric…</p>,
});

export default function RubricBars({ result }: { result: ComparisonResult }) {
  return <Inner result={result} />;
}
