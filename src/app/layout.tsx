import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GoT RAG Comparison — Vector vs Graph vs Hybrid",
  description: "Compare Vector RAG, Graph RAG, and Hybrid RAG on a Game of Thrones knowledge base.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
