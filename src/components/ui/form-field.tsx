"use client";

import { useEffect, useId, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";

type Field = { label: string; hint?: string };
export function TextField({ label, hint, ...props }: Field & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return <div className="control-field"><label htmlFor={id}>{label}</label><input {...props} id={id} className="control-input" aria-describedby={hint ? `${id}-hint` : undefined} />{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function TextAreaField({ label, hint, ...props }: Field & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return <div className="control-field"><label htmlFor={id}>{label}</label><textarea {...props} id={id} className="control-input" aria-describedby={hint ? `${id}-hint` : undefined} />{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
export function NumberField({ label, hint, value, onValueChange, unit, ...props }: Field & { value: number; onValueChange: (value: number) => void; unit?: string; min: number; max: number; step: number; disabled?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <div className="control-field"><label htmlFor={id}>{label}</label><div className="control-number"><input id={id} type="number" inputMode="decimal" aria-describedby={[unit ? `${id}-unit` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined} {...props} value={draft} onChange={e => {
    const next = e.target.value; setDraft(next);
    const number = Number(next);
    if (next.trim() && Number.isFinite(number) && number >= props.min && number <= props.max) onValueChange(number);
  }} onBlur={() => {
    const number = Number(draft);
    const next = draft.trim() && Number.isFinite(number) ? Math.min(props.max, Math.max(props.min, number)) : value;
    setDraft(String(next)); onValueChange(next);
  }} />{unit && <span id={`${id}-unit`}>{unit}</span>}</div>{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
