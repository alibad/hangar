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
              view === id ? "bg-indigo-600 on-accent" : "text-gray-400 hover:text-gray-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {/* No ModelPicker here. This tab is the one place it duplicated something
          that already existed: the studio has its own Model row, so the model
          appeared twice — once as a routing card at the top and again as the
          thing you actually generate with. Local vs cloud selection and the
          box-wide routing it writes now live in that one row. */}
      {view === "studio" ? <QwenStudio /> : <QwenActivity />}
    </div>
  );
}
