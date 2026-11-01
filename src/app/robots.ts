import type { MetadataRoute } from "next";
import { PUBLIC_SITE_URL } from "@/lib/public-site";
export default function robots():MetadataRoute.Robots{return {rules:[{userAgent:"*",allow:"/",disallow:["/api/"]}],sitemap:`${PUBLIC_SITE_URL}/sitemap.xml`};}
