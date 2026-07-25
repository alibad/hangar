"use client";

import { useState } from "react";
import QwenStudio from "./qwen-studio";
import QwenActivity from "./qwen-activity";

// The Qwen Image tab has two surfaces:
//  • Studio   — the curated, human-driven workspace (generate/edit/batch + a
//               foldered gallery of what you saved).
//  • Activity — a read-only firehose of EVERY image the box produces, from any
//               caller (console, quote-forge, scripts), tagged by source.
export default function QwenTab() {
  const [view, setView] = useState<"studio" | "activity">("studio");
  return (
    <div className="space-y-6">
      <div className="flex gap-1 bg-gray-900 border border-gray-800 rounded-xl p-1 w-fit">
        {(
          [
            ["studio", "Studio"],
            ["activity", "Activity"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition ${
              view === id ? "bg-indigo-600 text-white" : "text-gray-400 hover:text-gray-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "studio" ? <QwenStudio /> : <QwenActivity />}
    </div>
  );
}
