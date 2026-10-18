"use client";

import { useEffect, useId, useState, type ComponentPropsWithRef, type InputHTMLAttributes, type ReactNode } from "react";
import { FieldSelect, type FieldSelectProps } from "./field-select";
import { cn } from "@/lib/utils";

type Field = { label: string; hint?: string; fieldClassName?: string };
export function TextField({ label, hint, fieldClassName, className, id, ...props }: Field & ComponentPropsWithRef<"input">) {
  const generated = useId(), fieldId = id ?? generated;
  return <div className={cn("control-field", fieldClassName)}><label htmlFor={fieldId}>{label}</label><input {...props} id={fieldId} className={cn("control-input", className)} aria-describedby={[props["aria-describedby"], hint ? `${fieldId}-hint` : ""].filter(Boolean).join(" ") || undefined} />{hint && <small id={`${fieldId}-hint`}>{hint}</small>}</div>;
}
export function TextAreaField({ label, hint, fieldClassName, accessory, className, id, ...props }: Field & ComponentPropsWithRef<"textarea"> & { accessory?: ReactNode }) {
  const generated = useId(), fieldId = id ?? generated;
  return <div className={cn("control-field", accessory && "has-accessory", fieldClassName)}><label htmlFor={fieldId}>{label}</label><div className="control-input-shell"><textarea {...props} id={fieldId} className={cn("control-input", className)} aria-describedby={[props["aria-describedby"], hint ? `${fieldId}-hint` : ""].filter(Boolean).join(" ") || undefined} />{accessory}</div>{hint && <small id={`${fieldId}-hint`}>{hint}</small>}</div>;
}
export function SelectField({ label, hint, fieldClassName, id, ...props }: Field & FieldSelectProps) {
  const generated = useId(), fieldId = id ?? generated;
  return <div className={cn("control-field", fieldClassName)}><label htmlFor={fieldId}>{label}</label><FieldSelect {...props} id={fieldId} aria-label={props["aria-label"] ?? label} aria-describedby={[props["aria-describedby"], hint ? `${fieldId}-hint` : ""].filter(Boolean).join(" ") || undefined} popupClassName={cn("control-picker-popup", props.popupClassName)} />{hint && <small id={`${fieldId}-hint`}>{hint}</small>}</div>;
}
export function NumberField({ label, hint, fieldClassName, value, onValueChange, unit, id: providedId, ...props }: Field & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "min" | "max" | "step"> & { value: number; onValueChange: (value: number) => void; unit?: string; min: number; max: number; step: number }) {
  const generated = useId(), id = providedId ?? generated;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <div className={cn("control-field", fieldClassName)}><label htmlFor={id}>{label}</label><div className="control-number"><input {...props} id={id} type="number" inputMode="decimal" aria-describedby={[props["aria-describedby"], unit ? `${id}-unit` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined} value={draft} onChange={e => {
    const next = e.target.value; setDraft(next);
    const number = Number(next);
    if (next.trim() && Number.isFinite(number) && number >= props.min && number <= props.max) onValueChange(number);
  }} onBlur={() => {
    const number = Number(draft);
    const next = draft.trim() && Number.isFinite(number) ? Math.min(props.max, Math.max(props.min, number)) : value;
    setDraft(String(next)); onValueChange(next);
  }} />{unit && <span id={`${id}-unit`}>{unit}</span>}</div>{hint && <small id={`${id}-hint`}>{hint}</small>}</div>;
}
