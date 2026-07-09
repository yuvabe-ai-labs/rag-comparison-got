import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "GoT RAG Comparison — Vector vs Graph vs Hybrid",
  description: "Compare Vector RAG, Graph RAG, and Hybrid RAG on a Game of Thrones knowledge base.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={cn("dark h-full antialiased", "font-sans", geist.variable)}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
