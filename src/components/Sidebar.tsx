"use client";

import { ScrollArea } from "@/components/ui/scroll-area";

interface SidebarProps {
  onPick: (question: string) => void;
}

const GROUPS: {
  title: string;
  questions: { category: string; question: string }[];
}[] = [
  {
    title: "Graph Wins",
    questions: [
      {
        category: "count",
        question: "How many named characters belong to House Lannister?",
      },
      {
        category: "aggregation",
        question: "List every character Arya Stark kills.",
      },
      {
        category: "relationship constraint",
        question:
          "Which members of House Lannister betrayed another member of their own House?",
      },
    ],
  },
  {
    title: "Vector Wins",
    questions: [
      {
        category: "descriptive",
        question:
          "What happens at Daenerys's wedding to Khal Drogo, and what gifts does she receive?",
      },
      {
        category: "motivation",
        question: "Why does Tyrion Lannister kill his father Tywin?",
      },
      {
        category: "thematic",
        question:
          "What does Melisandre mean when she says 'the night is dark and full of terrors'?",
      },
    ],
  },
];

export default function Sidebar({ onPick }: SidebarProps) {
  return (
    <aside className="fixed left-0 top-0 z-40 hidden h-screen w-[22rem] border-r border-border bg-[#0d1119] md:block">
      <ScrollArea className="h-full px-3 py-5">
        <p className="mb-3 px-1 text-xl">Questions</p>

        {GROUPS.map((group) => (
          <div key={group.title} className="mb-5">
            <p className="px-2 py-2 text-sm font-semibold text-muted-foreground">
              {group.title}
            </p>
            <div className="flex flex-col gap-2">
              {group.questions.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => onPick(q.question)}
                  className="flex w-full flex-col gap-1 rounded-md border border-border bg-white/2 px-3 py-2.5 text-left transition-colors hover:border-slate-500 hover:bg-white/5"
                >
                  <span className="text-sm font-medium text-[#8fa0b8]">
                    category: {q.category}
                  </span>
                  <span className="text-sm font-normal leading-relaxed text-[#8fa0b8]">
                    {q.question}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </ScrollArea>
    </aside>
  );
}
