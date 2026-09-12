# Quranic font

`UthmanicHafs1Ver18.ttf` belongs here and is **not committed**.

Fetch it with:

```bash
npm run fetch:font
```

`npm install` attempts this automatically; `npm run build` refuses to proceed
without it.

## Why it is not committed

The KFGQPC Uthmanic Hafs face is published by the King Fahd Glorious Quran
Printing Complex for Quranic use. Fetching it at setup time keeps the licence
terms attached to the source you obtain it from, rather than silently
redistributing the binary with this repository. Review those terms before
vendoring it into a published image or a public fork.

## Why it is self-hosted rather than loaded cross-origin

Loading it from a third-party origin meant the stylesheet and the CSP
`font-src` had to agree about that origin. When they drifted the font was
blocked, the Arabic fell back to a system face, and nothing errored — a
rendering regression on the most important text in the app, invisible to every
automated check.

Serving it from this origin removes the CSP exception, removes a
render-blocking request to a host we do not control, and turns a missing font
into a build failure.

## Air-gapped builds

Place the `.ttf` here manually before building. `scripts/fetch-font.mjs` is
idempotent and will confirm rather than re-download.
