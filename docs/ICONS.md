# App icons — files still needed

These are referenced by `public/manifest.webmanifest` and `index.html` and are
**not yet in the repo**. Until they are, iOS falls back to a screenshot of the
page for the home-screen icon.

Drop them in `public/` (Vite copies that directory to the site root verbatim):
`public/apple-touch-icon.png` and `public/icons/*.png`. This file lives in
`docs/` rather than beside them so it isn't published with the site.

Generate all of them from the locked helmet mark — navy shell, gold centre
stripe, gold facemask (see `docs/DESIGN.md`). Never substitute a placeholder or
an approximation; the mark is authored outside this repo.

| file | size | notes |
| --- | --- | --- |
| `apple-touch-icon.png` | 180×180 | iOS home screen. Helmet only — the wordmark is unreadable at this size. No transparency; iOS composites onto white and a transparent background looks broken. No rounded corners either, iOS applies its own mask. |
| `icon-192.png` | 192×192 | manifest, Android/desktop |
| `icon-512.png` | 512×512 | manifest, splash |
| `icon-maskable-512.png` | 512×512 | `purpose: maskable`. Keep the helmet inside the centre 80% safe area — Android crops to a circle and anything outside that ring is cut. |

`apple-touch-icon.png` goes at `public/` root, not in this directory, because
`index.html` links it from `/apple-touch-icon.png`.

## After dropping the files in

No code changes needed — the manifest and `index.html` already point at these
paths. Just `npm run build` and deploy.

On iOS the icon is captured when the user taps **Add to Home Screen**, so an
existing home-screen shortcut keeps whatever icon it was created with. Remove
and re-add it to pick up a new one.
