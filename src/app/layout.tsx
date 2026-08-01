import type { Metadata } from "next";
import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";
import { ThemeProvider } from "@/components/theme-provider";
import { DEFAULT_THEME, THEME_IDS } from "@/lib/themes";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: "BeTenshi Console",
  description: "Monitor and test BeTenshi AI services",
  manifest: "/manifest.json",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "BeTenshi" },
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
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
