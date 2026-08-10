"use client";

import type { ReactNode } from "react";

type ToolPageHeaderProps = {
  eyebrow: string;
  title: string;
  description: string;
  icon: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
};

export function ToolPageHeader({ eyebrow, title, description, icon, meta, actions }: ToolPageHeaderProps) {
  return (
    <header className="tool-page-hero">
      <div className="tool-page-icon" aria-hidden="true">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="tool-page-eyebrow">{eyebrow}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="tool-page-title">{title}</h1>
          {meta}
        </div>
        <p className="tool-page-description">{description}</p>
      </div>
      {actions && <div className="tool-page-actions">{actions}</div>}
    </header>
  );
}

export function ToolSectionHeading({ eyebrow, title, description, action }: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="tool-section-heading">
      <div className="min-w-0">
        {eyebrow && <p className="tool-section-eyebrow">{eyebrow}</p>}
        <h2 className="tool-section-title">{title}</h2>
        {description && <p className="tool-section-description">{description}</p>}
      </div>
      {action}
    </div>
  );
}
