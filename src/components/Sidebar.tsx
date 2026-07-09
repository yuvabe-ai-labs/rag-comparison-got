"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import type { QuestionItem } from "@/lib/webTypes";

interface SidebarProps {
  questions: QuestionItem[];
  onPick: (question: string) => void;
}

const questionButton =
  "h-auto justify-start whitespace-normal px-2.5 py-2 text-left text-sm font-normal leading-relaxed text-[#8fa0b8] hover:text-foreground";

export default function Sidebar({ questions, onPick }: SidebarProps) {
  const categories = [...new Set(questions.map((q) => q.category).filter(Boolean))].sort();
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(categories.map((c) => [c, true])),
  );
  const uncategorized = questions.filter((q) => !q.category);

  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-[22rem] border-r border-border bg-[#0d1119] md:block">
      <ScrollArea className="h-full px-3 py-5">
        <p className="kg-micro mb-3 px-1">Gold Questions</p>

        {categories.map((cat) => {
          const catQs = questions.filter((q) => q.category === cat);
          const isOpen = open[cat] ?? true;
          return (
            <Collapsible
              key={cat}
              open={isOpen}
              onOpenChange={(v) => setOpen((o) => ({ ...o, [cat]: v }))}
              className="mb-1"
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-between px-2 py-2 text-sm font-semibold text-muted-foreground"
                >
                  <span>{cat}</span>
                  <span className="text-xs">{isOpen ? "▾" : "▸"}</span>
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="flex flex-col pb-1">
                {catQs.map((q, i) => (
                  <Button key={i} variant="ghost" onClick={() => onPick(q.question)} className={questionButton}>
                    {q.question}
                  </Button>
                ))}
              </CollapsibleContent>
            </Collapsible>
          );
        })}

        {uncategorized.length > 0 && (
          <div className="mt-4 flex flex-col">
            {uncategorized.map((q, i) => (
              <Button key={i} variant="ghost" onClick={() => onPick(q.question)} className={questionButton}>
                {q.question}
              </Button>
            ))}
          </div>
        )}
      </ScrollArea>
    </aside>
  );
}
