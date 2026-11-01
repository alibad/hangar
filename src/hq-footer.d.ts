// The shared Human Quest footer, a custom element loaded from https://www.humanquest.net/embed/hq-footer.js.
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hq-footer": DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { current?: string; theme?: "auto" | "light" | "dark" };
    }
  }
}
