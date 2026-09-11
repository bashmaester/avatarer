# avatarer

A p5.js full-body character rig inspired by the “DNA / Motion / Style” architecture in [all my friends are made of javascript](https://allmyfriendsaremadeofjavascript.nikolaj-sokolowski.de/docs/en/).

## What is implemented

- Seeded avatar DNA: the same text seed always produces the same proportions, colours, hair, face details, and clothing style.
- Hand-drawn p5 renderer: sketchy outlines, paper grain, cheek colour, blinking, breathing, chatter, and an 8-beat line “boil”.
- Full-body rig: head, neck, shoulders, elbows, wrists, hips, knees, ankles, feet, hands, torso, clothing, hair, and face.
- Manual driver: mouse controls the selected effector and the keyboard moves/poses the body.
- Live driver: MediaPipe Pose Landmarker can drive the rig from a webcam feed.

## Run locally

This is a static web sketch. Serve the repository root so browser modules and webcam permissions work correctly:

```bash
npm start
# or: python3 -m http.server 5173 --bind 0.0.0.0
```

Then open <http://localhost:5173>.

## Controls

### Manual rig

- `1` / `2` / `3` / `4` / `5`: select left hand, right hand, left foot, right foot, or head/gaze.
- Mouse: drives the selected control when “Mouse drives selected control” is enabled.
- `WASD` or arrow keys: move the body.
- `Q` / `E`: lean.
- `C`: crouch.
- `Space`: bounce.
- `B`: blink.
- `M`: talk/chatter.
- `P`: reset the manual pose.

### MediaPipe live

1. Switch to **MediaPipe live**.
2. Click **Start camera** and allow camera access.
3. Stand back so shoulders, hips, knees, and ankles are visible.
4. Optional: enable **Show camera ghost** or **Show rig bones** for debugging.

p5.js is vendored in `vendor/p5.min.js` so manual mode works from a plain static server. MediaPipe assets are loaded from the official CDN/model URLs at runtime, so live mode requires network access and a browser context where webcam access is allowed.
