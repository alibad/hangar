"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Check, ChevronDown, Globe2, X } from "lucide-react";
import { useTheme, WORLD_STYLES } from "./theme-provider";
import "./world-style-picker.css";

/** The preview images are captures of this renderer with a synthetic project catalog. */
export default function WorldStylePicker() {
  const { worldStyle, setWorldStyle } = useTheme();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = WORLD_STYLES.find(style => style.id === worldStyle) || WORLD_STYLES[0];
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    return () => { element?.close(); trigger.current?.focus(); };
  }, [open]);
  const step = (direction: number) => {
    const index = WORLD_STYLES.findIndex(style => style.id === worldStyle);
    setWorldStyle(WORLD_STYLES[(index + direction + WORLD_STYLES.length) % WORLD_STYLES.length].id);
  };

  return <>
    <button ref={trigger} type="button" className="world-style-trigger" aria-label={`World style: ${current.name}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><Globe2 size={16} /><span>{current.name}</span><ChevronDown size={12} /></button>
    {open && createPortal(<dialog ref={dialog} className="world-style-dialog" aria-labelledby="world-style-title" onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="world-style-content">
        <header><div><p className="world-style-eyebrow">A different perspective</p><h2 id="world-style-title">Choose your world</h2><p>Your projects, in ten new worlds. City and aircraft are here too.</p></div><button type="button" className="world-style-close" aria-label="Close world chooser" onClick={() => setOpen(false)} autoFocus><X size={19} /></button></header>
        <div className="world-style-grid" role="group" aria-label="World styles">
          {WORLD_STYLES.map(style => <button key={style.id} type="button" className="world-style-card" aria-pressed={style.id === worldStyle} onClick={() => setWorldStyle(style.id)}>
            <img src={`/world-styles/${style.id}.webp`} alt="" width="480" height="300" loading="lazy" />
            <span className="world-style-card-text"><span><b>{style.name}</b>{style.id === worldStyle && <Check size={16} aria-hidden="true" />}</span><small>{style.hint}</small></span>
          </button>)}
        </div>
        <footer><div className="world-style-compare"><button type="button" aria-label="Previous world" onClick={() => step(-1)}><ArrowLeft size={16} /></button><span><b>{current.name}</b><small>{current.growth}</small></span><button type="button" aria-label="Next world" onClick={() => step(1)}><ArrowRight size={16} /></button></div><button type="button" className="world-style-explore" onClick={() => setOpen(false)}>Explore {current.name.toLowerCase()} <ArrowRight size={16} /></button></footer>
      </div>
    </dialog>, document.body)}
  </>;
}
