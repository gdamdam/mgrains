// PWA icon generation — rasterizes the brand mark SVG into committed PNGs.
//
// WHY committed PNGs (not runtime rasterization): many launchers and all of iOS
// ignore SVG manifest icons, so installability needs real raster icons. Baking
// them at authoring time keeps the shipped app dependency-free — sharp runs only
// here, never in the browser or the production bundle.
//
// Regenerate whenever public/mgrains-mark.svg changes:  npm run icons
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'public', 'mgrains-mark.svg')
const outDir = join(root, 'public', 'icons')

// Matches the mark's own background rect. Used as the solid fill for maskable and
// apple-touch icons, which must be opaque (iOS + circular masks show no alpha).
const BG = '#10120f'
// Render the SVG at high density first so downscales stay crisp at every size.
const DENSITY = 384

await mkdir(outDir, { recursive: true })

// "any" purpose: rasterize the mark as-is — it already carries its rounded
// background, so transparent corners are intentional on platforms that honor them.
for (const size of [192, 512]) {
  await sharp(src, { density: DENSITY })
    .resize(size, size)
    .png()
    .toFile(join(outDir, `icon-${size}.png`))
}

// Maskable 512: scale the mark into the ~80% safe zone (≈10% padding per side) on
// a full-bleed solid background so nothing important is clipped by circular or
// rounded platform masks. BG matches the mark rect, so the fill reads seamlessly.
const MASK = 512
const inner = Math.round(MASK * 0.8)
const mark = await sharp(src, { density: DENSITY }).resize(inner, inner).png().toBuffer()
await sharp({ create: { width: MASK, height: MASK, channels: 4, background: BG } })
  .composite([{ input: mark, gravity: 'center' }])
  .png()
  .toFile(join(outDir, 'maskable-512.png'))

// apple-touch-icon 180: flatten onto solid BG — iOS renders no transparency and
// applies its own rounded mask, so a full opaque square is required.
await sharp(src, { density: DENSITY })
  .resize(180, 180)
  .flatten({ background: BG })
  .png()
  .toFile(join(outDir, 'apple-touch-icon-180.png'))

console.log('Generated PWA icons in public/icons/')
