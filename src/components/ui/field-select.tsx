"use client";

import { Children, Fragment, isValidElement, type ReactNode, type ButtonHTMLAttributes } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "./select";
import { cn } from "@/lib/utils";

type Choice = { value: string; label: ReactNode; disabled: boolean; group?: string };
type FieldSelectProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value" | "defaultValue" | "onChange" | "children"> & {
  value?: string | number;
  defaultValue?: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  name?: string;
  required?: boolean;
  popupClassName?: string;
};

// Existing option lists stay declarative. They are data only: no visible native
// select or option is mounted. Base UI owns focus, typeahead and popup behavior.
function choicesFrom(children: ReactNode, group?: string): Choice[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<{ value?: string | number; disabled?: boolean; children?: ReactNode; label?: string }>(child)) return [];
    if (child.type === Fragment) return choicesFrom(child.props.children, group);
    if (child.type === "optgroup") return choicesFrom(child.props.children, child.props.label);
    if (child.type !== "option") return [];
    return [{ value: String(child.props.value ?? child.props.children ?? ""), label: child.props.children, disabled: Boolean(child.props.disabled), group }];
  });
}

export function FieldSelect({ value, defaultValue, onValueChange, children, className, popupClassName, name, required, disabled, ...triggerProps }: FieldSelectProps) {
  const choices = choicesFrom(children);
  const selected = value == null ? undefined : String(value);
  const items = choices.map(choice => ({ value: choice.value, label: choice.label }));
  const groups = [...new Set(choices.map(choice => choice.group))];
  return (
    <Select items={items} value={selected} defaultValue={defaultValue == null ? undefined : String(defaultValue)} onValueChange={next => { if (next != null) onValueChange(String(next)); }} name={name} required={required} disabled={disabled}>
      <SelectTrigger {...triggerProps} className={cn("workspace-field-select", className)} aria-label={triggerProps["aria-label"] ?? (triggerProps["aria-labelledby"] ? undefined : "Choose option")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className={cn("workspace-picker-popup", popupClassName)}>
        {groups.map(group => <SelectGroup key={group ?? "ungrouped"}>
          {group && <SelectLabel>{group}</SelectLabel>}
          {choices.filter(choice => choice.group === group).map(choice => <SelectItem key={choice.value} value={choice.value} disabled={choice.disabled}>{choice.label}</SelectItem>)}
        </SelectGroup>)}
      </SelectContent>
    </Select>
  );
}
