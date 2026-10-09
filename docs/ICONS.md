# App icons

Referenced by `public/manifest.webmanifest` and `index.html`, and present in
`public/` (Vite copies that directory to the site root verbatim):
`public/apple-touch-icon.png` and `public/icons/*.png`. This file lives in
`docs/` rather than beside them so it isn't published with the site.

All of them are resampled from the helmet mark — navy shell, gold centre
stripe, gold facemask (see `docs/DESIGN.md`). The source is
`docs/brand/helmet-source.jpg` (generated 2026-10-09; the copy in the repo is
the 200px preview, the 1264px original lives in Canva and should replace it
when it can be downloaded). The header mark `public/brand/helmet.png` is the
same image with the navy background knocked out. To regenerate after swapping
the source:

```bash
convert docs/brand/helmet-source.jpg -strip -resize 180x180 png24:public/apple-touch-icon.png
convert docs/brand/helmet-source.jpg -strip -resize 192x192 png24:public/icons/icon-192.png
convert docs/brand/helmet-source.jpg -strip -resize 512x512 png24:public/icons/icon-512.png
convert -size 512x512 xc:'#020923' \( docs/brand/helmet-source.jpg -strip -resize 400x400 \) -gravity center -composite png24:public/icons/icon-maskable-512.png
```

| file | size | notes |
| --- | --- | --- |
| `apple-touch-icon.png` | 180×180 | iOS home screen. Helmet only — the wordmark is unreadable at this size. No transparency; iOS composites onto white and a transparent background looks broken. No rounded corners either, iOS applies its own mask. |
| `icon-192.png` | 192×192 | manifest, Android/desktop |
| `icon-512.png` | 512×512 | manifest, splash |
| `icon-maskable-512.png` | 512×512 | `purpose: maskable`. Keep the helmet inside the centre 80% safe area — Android crops to a circle and anything outside that ring is cut. |

`apple-touch-icon.png` goes at `public/` root, not in this directory, because
`index.html` links it from `/apple-touch-icon.png`.

## After changing the files

No code changes needed — the manifest and `index.html` already point at these
paths. Just `npm run build` and deploy.

On iOS the icon is captured when the user taps **Add to Home Screen**, so an
existing home-screen shortcut keeps whatever icon it was created with. Remove
and re-add it to pick up a new one.
