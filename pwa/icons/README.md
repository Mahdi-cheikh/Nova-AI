# PWA icons

Three icons are referenced from `manifest.json` and `sw.js`. Generate them once and drop the PNGs in this folder:

| File                       | Size      | Purpose                                    |
| -------------------------- | --------- | ------------------------------------------ |
| `icon-192.png`             | 192 × 192 | Home-screen icon, shortcut icon, push      |
| `icon-512.png`             | 512 × 512 | Splash screen, larger device tiles         |
| `icon-maskable-512.png`    | 512 × 512 | Adaptive (Android) — design fits a circle  |

## Quick way to generate

The fastest path is **realfavicongenerator.net** — upload one square SVG/PNG of the **N** logo on the gradient background, pick "PWA" output, download the bundle, drop the three files above into this folder.

If you'd rather generate them programmatically, here's the source SVG that matches Nova's brand. Save it as `icon-source.svg`, then convert:

```bash
# requires `rsvg-convert` (brew install librsvg) or ImageMagick
rsvg-convert -w 192 -h 192 icon-source.svg > icon-192.png
rsvg-convert -w 512 -h 512 icon-source.svg > icon-512.png
rsvg-convert -w 512 -h 512 icon-source.svg > icon-maskable-512.png
```

## icon-source.svg

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%"   stop-color="#6366f1"/>
      <stop offset="50%"  stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="120" fill="url(#g)"/>
  <text x="256" y="340" text-anchor="middle"
        font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif"
        font-size="290" font-weight="800" fill="#ffffff" letter-spacing="-8">N</text>
</svg>
```

Until you generate real icons, the PWA still installs — just with a default placeholder icon.
