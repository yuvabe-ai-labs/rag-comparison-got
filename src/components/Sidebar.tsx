"use client";

import { useState } from "react";
import type { QuestionItem } from "@/lib/webTypes";

interface SidebarProps {
  questions: QuestionItem[];
  onPick: (question: string) => void;
}

export default function Sidebar({ questions, onPick }: SidebarProps) {
  const categories = [...new Set(questions.map((q) => q.category).filter(Boolean))].sort();
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(categories.map((c) => [c, true])),
  );
  const uncategorized = questions.filter((q) => !q.category);

  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-[22rem] overflow-y-auto border-r border-border bg-[#0d1119] px-3 py-5 md:block">
      <p className="kg-micro mb-3 px-1">Gold Questions</p>

      {categories.map((cat) => {
        const catQs = questions.filter((q) => q.category === cat);
        const isOpen = open[cat] ?? true;
        return (
          <div key={cat} className="mb-1">
            <button
              onClick={() => setOpen((o) => ({ ...o, [cat]: !isOpen }))}
              className="flex w-full items-center justify-between rounded px-2 py-2 text-sm font-semibold text-muted-foreground hover:bg-accent"
            >
              <span>{cat}</span>
              <span className="text-xs">{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen && (
              <div className="flex flex-col pb-1">
                {catQs.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => onPick(q.question)}
                    className="rounded px-2.5 py-2 text-left text-sm leading-relaxed text-[#8fa0b8] transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {q.question}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {uncategorized.length > 0 && (
        <div className="mt-4 flex flex-col">
          {uncategorized.map((q, i) => (
            <button
              key={i}
              onClick={() => onPick(q.question)}
              className="rounded px-2.5 py-2 text-left text-sm leading-relaxed text-[#8fa0b8] transition-colors hover:bg-accent hover:text-foreground"
            >
              {q.question}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
