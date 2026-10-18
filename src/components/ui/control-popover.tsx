"use client";

import { Popover } from "@base-ui/react/popover";
import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ControlPopover({ open, onOpenChange, trigger, label, children, className }: {
  open: boolean; onOpenChange: (open: boolean) => void; trigger: ReactElement;
  label: string; children: ReactNode; className?: string;
}) {
  return <Popover.Root open={open} onOpenChange={onOpenChange}>
    <Popover.Trigger render={trigger} />
    <Popover.Portal>
      <Popover.Positioner side="top" align="end" sideOffset={8} collisionPadding={{ top: 76, bottom: 16, left: 16, right: 16 }} className="control-popover-positioner">
        <Popover.Popup className={cn("control-popover", className)}>
          <Popover.Title className="control-popover-title">{label}</Popover.Title>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
