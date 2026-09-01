# Preset video backgrounds

Every preset shipped here is **CC0 1.0 (public domain dedication)** — no
attribution is required. It's recorded anyway, because knowing where an asset
came from is what makes it safe to keep shipping it.

All six were sourced from Wikimedia Commons (originally Unsplash), then
centre-cropped to 16:9 and re-encoded: `<id>.jpg` at 1280×720 (drawn behind the
person) and `<id>-thumb.jpg` at 256×144 (the lobby picker's tile — the only
thing the picker downloads).

| id             | title                        | author            | licence | source                                                                                        |
| -------------- | ---------------------------- | ----------------- | ------- | --------------------------------------------------------------------------------------------- |
| `bookshelves`  | Uppsala Library              | Aleksi Tappura    | CC0     | https://commons.wikimedia.org/wiki/File:Uppsala_Library_(Unsplash).jpg                        |
| `studio`       | Minimalist office decor      | Breather          | CC0     | https://commons.wikimedia.org/wiki/File:Minimalist_office_decor_at_1540_7th_St_(Unsplash).jpg |
| `meeting-room` | Chairs in a meeting room     | Breather          | CC0     | https://commons.wikimedia.org/wiki/File:Chairs_in_a_meeting_room_(Unsplash).jpg               |
| `living-room`  | Living room                  | Jarosław Ceborski | CC0     | https://commons.wikimedia.org/wiki/File:Living_room_(Unsplash).jpg                            |
| `beach`        | Blue ocean by the sand beach | Jason Briscoe     | CC0     | https://commons.wikimedia.org/wiki/File:Blue_ocean_by_the_sand_beach_(Unsplash).jpg           |
| `mountains`    | Diablo Lake, United States   | Sergei Akulich    | CC0     | https://commons.wikimedia.org/wiki/File:Diablo_Lake,_United_States_(Unsplash_ZNkvxIPPVeE).jpg |

## The segmentation model

`../models/selfie_segmenter_landscape.tflite` is Google's MediaPipe Selfie
Segmenter (landscape, 144×256 input, float16), Apache-2.0, from
`https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite`.
The landscape variant matches our 16:9 capture, so nothing is wasted on
letterboxing. It sits beside the BlazeFace model the face-centering guidance
already uses, and is fetched only when someone actually turns on a background.

## Adding or replacing a preset

1. Drop `<id>.jpg` (1280×720) and `<id>-thumb.jpg` (256×144) in here.
2. Add the row above, with a real licence and source.
3. Add the id to `BACKGROUND_PRESETS` in `client/src/lib/video/backgrounds.ts`
   and its label key to `client/messages/*.json`.

Pick images that are calm in the middle: that's where the person sits, and a
busy centre is exactly where imperfect segmentation shows.
