"use client";

import { useState } from "react";
import QwenStudio from "./qwen-studio";
import QwenActivity from "./qwen-activity";
import { ImageSquare } from "@phosphor-icons/react";
import { ToolPageHeader } from "./tool-page";

// The Qwen Image tab has two surfaces:
//  • Studio   — the curated, human-driven workspace (generate/edit/batch + a
//               foldered gallery of what you saved).
//  • Activity — a read-only firehose of EVERY image the box produces, from any
//               caller (console, quote-forge, scripts), tagged by source.
export default function QwenTab() {
  const [view, setView] = useState<"studio" | "activity">("studio");
  return (
    <div className="tool-page image-page space-y-4">
      <ToolPageHeader
        eyebrow="Visual workstream"
        title="Image Studio"
        description="Generate, edit, compare, and revisit local or cloud images."
        icon={<ImageSquare size={22} weight="duotone" />}
        actions={
          <div className="image-view-switch" role="tablist" aria-label="Image Studio view">
            {(
              [
                ["studio", "Create"],
                ["activity", "Activity"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={view === id ? "is-active" : undefined}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />
      {/* No ModelPicker here. This tab is the one place it duplicated something
          that already existed: the studio has its own Model row, so the model
          appeared twice — once as a routing card at the top and again as the
          thing you actually generate with. Local vs cloud selection and the
          box-wide routing it writes now live in that one row. */}
      {view === "studio" ? <QwenStudio /> : <QwenActivity />}
    </div>
  );
}
