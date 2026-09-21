"use client";

import { useEffect } from "react";

const PUBLIC_GUIDE_HOSTS = new Set(["console.humanquest.net", "hangar.humanquest.net"]);

/**
 * Middleware owns the public/private split on a fresh request. This is a second
 * line of defence for client-side navigation and restored browser sessions: a
 * public Human Quest hostname must never remain on a machine-console route.
 */
export default function PublicHostGuard() {
  useEffect(() => {
    const host = window.location.hostname.toLowerCase();
    const isPublicGuide = PUBLIC_GUIDE_HOSTS.has(host) || host.endsWith(".vercel.app");

    const isGuidePath = window.location.pathname === "/" || window.location.pathname === "/guide";

    if (isPublicGuide && !isGuidePath) {
      window.location.replace(`/${window.location.search}`);
    }
  }, []);

  return null;
}
