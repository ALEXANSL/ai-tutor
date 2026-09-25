import type { MetadataRoute } from "next";
import { uk } from "@/i18n/uk";

/** PWA manifest (US-1.4): installable from Chrome, opens full-screen from the icon. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: uk.app.name,
    short_name: uk.app.shortName,
    description: uk.app.description,
    lang: "uk",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#FAF6EF",
    theme_color: "#FAF6EF",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
