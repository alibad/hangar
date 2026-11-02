"use client";

import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { openLibrary } from "@/lib/library-nav";
import { previewUrl, type LibraryItem } from "./library-shared";
import "./library.css";

/**
 * A World project's newest posters, a strip under its name. Shown only for a
 * project config/library.local.json maps to Library folders, and only when it
 * has something to show.
 */
export default function ProjectMedia({ repo }: { repo: string }) {
  const [data, setData] = useState<{ project: string | null; items: LibraryItem[]; total: number } | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/library?view=project&repo=${encodeURIComponent(repo)}&limit=8`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && setData(d))
      .catch(() => {});
    return () => { live = false; };
  }, [repo]);

  if (!data?.project || !data.items.length) return null;
  const project = data.project;
  return (
    <section className="lib-project-media" aria-label={`${project} media`}>
      <button type="button" className="lib-project-media-head" onClick={() => openLibrary({ project })}>
        <b>Media</b><small>{new Intl.NumberFormat().format(data.total)}</small><ArrowRight size={14} />
      </button>
      <div className="lib-project-media-strip">
        {data.items.map((it) => (
          <button key={it.id} type="button" title={it.prompt ?? it.name} onClick={() => openLibrary({ project, group: it.group ?? undefined })}>
            <img src={previewUrl(it, "poster", 240)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
          </button>
        ))}
      </div>
    </section>
  );
}
