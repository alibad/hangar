import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { DEFAULT_THEME, THEME_IDS } from "@/lib/themes";
import { getHost } from "@/lib/host";
import { isHostedRuntime } from "@/lib/runtime";
import PublicHostGuard from "@/components/public-host-guard";

const HOST = getHost();
const HOSTED = isHostedRuntime();
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://console.humanquest.net";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: HOSTED ? "Hangar — Set up local AI for your machine" : `Hangar — ${HOST.name} console`,
  description: HOSTED
    ? "Give the Hangar setup skill to Codex or Claude Code. It measures your machine, chooses a local LLM that fits, and verifies your private local AI console."
    : `Operate the AI services, models, memory budget, and request history on ${HOST.name}.`,
  alternates: { canonical: "/" },
  robots: HOSTED ? { index: true, follow: true } : undefined,
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Hangar" },
  icons: {
    icon: "/icons/icon.svg",
    apple: "/icons/icon-192.png",
  },
  other: { "mobile-web-app-capable": "yes" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      data-theme={DEFAULT_THEME}
      className={cn("dark font-sans", geist.variable)}
      suppressHydrationWarning
    >
      <head>
        {/* Applies the saved palette before first paint. Without this the page
            renders one frame in the default theme and then snaps to the saved
            one, which is very visible when the two have different canvases. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem("bt-palette");if(p&&${JSON.stringify(
              THEME_IDS,
            )}.indexOf(p)>-1)document.documentElement.dataset.theme=p;if(localStorage.getItem("bt-theme")==="light")document.documentElement.classList.remove("dark")}catch(e){}})()`,
          }}
        />
      </head>
      <body className="bg-gray-950 text-gray-100 min-h-screen">
        <PublicHostGuard />
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
