import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "SurahSpot \u2014 Identify the Surah",
  description:
    "Listen to a complete ayah and identify its Surah in five tries across a seven-round attempt.",
  applicationName: "SurahSpot",
  manifest: "/manifest.webmanifest",
  // Browser auto-translation rewrites the Arabic and the vetted translation,
  // which would both corrupt the text and hand over the answer. The meta tag
  // covers Google Translate; translate="no" on the elements covers the rest.
  other: { google: "notranslate" },
  icons: {
    // Only the SVG mark is shipped. Listing PNG sizes that do not exist in
    // public/ would produce a 404 on every page load, and an SVG favicon is
    // supported everywhere this app targets.
    icon: [{ url: "/brand/surahspot-mark.svg", type: "image/svg+xml" }],
    apple: [{ url: "/brand/surahspot-mark.svg", type: "image/svg+xml" }],
  },
  appleWebApp: {
    capable: true,
    title: "SurahSpot",
    // "default" keeps the iOS status bar legible against the paper background.
    statusBarStyle: "default",
  },
  formatDetection: {
    // Stops iOS turning ayah numbers and Juz references into phone-number links.
    telephone: false,
    date: false,
    address: false,
  },
  // The app is a game with no shareable per-round state, and round URLs would
  // leak answers if they existed. Keep it out of indexes entirely.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Pinch-zoom stays available. Locking it would fail WCAG 1.4.4, and the
  // Arabic is exactly the content someone would want to magnify.
  maximumScale: 5,
  userScalable: true,
  // Lets the layout paint under the notch and home indicator; the CSS then
  // pads content back in with env(safe-area-inset-*).
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ec" },
    { media: "(prefers-color-scheme: dark)", color: "#141714" },
  ],
};

/**
 * Resolve the stored theme before first paint.
 *
 * Without this the document renders in light mode and then flips once React
 * hydrates, which on a dark-mode phone is a full-screen white flash. It runs
 * inline and synchronously in <head> because that is the only place early
 * enough to matter, and it is wrapped in try/catch because private browsing
 * modes throw on localStorage access.
 */
const THEME_BOOTSTRAP = `
(function(){
  try {
    var stored = localStorage.getItem("surahspot:theme");
    var mode = (stored === "light" || stored === "dark" || stored === "system") ? stored : "system";
    var resolved = mode === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : mode;
    var root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themeMode = mode;
    root.style.colorScheme = resolved;
  } catch (error) {
    document.documentElement.dataset.theme = "light";
  }
})();
`;

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="google" content="notranslate" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
