# iPhone Mockup Tool

A browser-based tool for compositing screenshots onto iPhone frame PNGs. Select a model and color, upload a screenshot, and download the finished mockup — no backend required.

![Desktop Preview](preview.png)

## Live Demo

**[https://iphone-mockup.pages.dev](https://iphone-mockup.pages.dev)**

## Features

- 4 iPhone models: iPhone 17, iPhone 17 Pro, iPhone 17 Pro Max, iPhone Air
- 16 color variants across all models
- Pixel-perfect screen compositing via alpha-channel flood-fill masking
- Collapsible sidebar — works on desktop and mobile
- Auto-detects screen coordinates on first use (saved to `localStorage`)
- Pure client-side — no server, no uploads, no dependencies

## Usage

**Online:** Use the deployed app directly at [https://iphone-mockup.pages.dev](https://iphone-mockup.pages.dev)

**Local development:** The tool requires HTTP serving (not `file://`) due to browser CORS restrictions on `getImageData`.

```bash
python -m http.server 8080
# then open http://localhost:8080
```

## Workflow

1. **Select model** — iPhone 17 / iPhone 17 Pro / iPhone 17 Pro Max / iPhone Air
2. **Select color** — color list updates automatically per model
3. **Upload screenshot** — click the upload area or drag and drop
4. **Download** — click "Download PNG" to save the finished mockup

Screen coordinates are auto-detected on first use and saved to `localStorage`. Use the **Screen Area Calibration** panel to re-detect or fine-tune manually.

## UI

![Mobile Preview](preview-mobile.png)

The interface uses a collapsible sidebar panel:

- **Toggle button** — located in the sidebar header next to the "Model" label (box with arrow icon). Click to collapse or expand.
- **Desktop** — sidebar uses fluid width (`clamp(240px, 22vw, 360px)`). When collapsed, it slides off-screen and the toggle button pins to the left edge of the viewport.
- **Mobile (≤768px)** — sidebar opens as a full-height overlay drawer with a darkened backdrop. Tapping the backdrop or selecting a model/color closes it automatically.

## Supported Models and Colors

| Model | Colors |
|-------|--------|
| iPhone 17 | Black, White, Lavender, Mist Blue, Sage |
| iPhone 17 Pro | Cosmic Orange, Deep Blue, Silver |
| iPhone 17 Pro Max | Cosmic Orange, Deep Blue, Silver |
| iPhone Air | Cloud White, Light Gold, Sky Blue, Space Black |

Frame PNGs live in `PNG/{model}/{model} - {color} - Portrait.png`.

## How Compositing Works

iPhone frame PNGs contain two transparent regions that look identical (alpha ≈ 0):

- **Outer background** — outside the phone silhouette
- **Screen hole** — the display cutout inside the phone (squircle shape)

Simple alpha masking cannot distinguish between them. The pipeline solves this with a flood-fill approach:

1. **Flood-fill from edges** — marks all outer background pixels
2. **Single-pass scan** — any remaining transparent pixel is the screen hole; opaque pixels define the frame bounding box
3. **Build pixel-perfect mask** — each inner pixel gets `maskAlpha = 255 - frameAlpha`, giving smooth anti-aliased squircle edges
4. **Composite** — draw screenshot → apply mask via `destination-in` → draw frame on top

This produces pixel-perfect squircle clipping from the frame PNG's own anti-aliased edges, with no manual geometry needed.

Download cropping uses the frame bounding box (computed in the same scan) to strip transparent padding from the output PNG.

## Project Structure

```
├── index.html          # UI layout
├── style.css           # Styles and responsive layout
├── app.js              # All application logic
├── preview.png         # Desktop screenshot
├── preview-mobile.png  # Mobile screenshot
└── PNG/
    ├── iPhone 17/
    ├── iPhone 17 Pro/
    ├── iPhone 17 Pro Max/
    └── iPhone Air/
```

## Adding New Models

1. Place frame PNGs in `PNG/{model name}/` with the naming convention:
   ```
   {model name} - {color} - Portrait.png
   ```
2. Add an entry to `MODEL_COLORS` in `app.js`:
   ```js
   'iPhone XX': ['Color A', 'Color B'],
   ```
3. Add color swatches to `COLOR_SWATCHES` in `app.js` (hex values):
   ```js
   'Color A': '#rrggbb',
   ```
4. Add a model button to `index.html`:
   ```html
   <button class="model-btn" data-model="iPhone XX">iPhone XX</button>
   ```

Screen coordinates are auto-detected on first use — no manual calibration needed.
