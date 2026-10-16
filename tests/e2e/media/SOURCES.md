# Test media

## dance-naenae.mp4

A single dancer, full body in frame, facing the camera, static camera, plain wall: the Nae Nae (one arm waving up,
the other out, knees bending), 7.4 s, 540×960, 30 fps, H.264, no audio.

- Source: "Watch Me Nae Nae - Tutorial.webm" on Wikimedia Commons,
  https://commons.wikimedia.org/wiki/File:Watch_Me_Nae_Nae_-_Tutorial.webm
  (originally YouTube https://www.youtube.com/watch?v=Gf--SLrojOU, published under CC BY by its author).
- Author: El Martial (https://www.youtube.com/@el.martial).
- Licence: Creative Commons Attribution 3.0 (CC BY 3.0), https://creativecommons.org/licenses/by/3.0/
- Changes: scaled from 1080×1920 to 540×960 and re-encoded from VP9 WebM to H.264 MP4 (the source has no audio):
  `ffmpeg -i "Watch_Me_Nae_Nae_-_Tutorial.webm" -vf "scale=540:960:flags=lanczos,fps=30" -c:v libx264
  -profile:v main -pix_fmt yuv420p -crf 23 -preset slow -movflags +faststart -an dance-naenae.mp4`

Used by `tests/e2e/run.mjs` as Chrome's fake webcam (converted to y4m in `.cache/e2e/` at test time) and as the
portrait file uploaded in video mode.

## dance-waacking.mp4

One dancer, full body, facing the camera most of the time, static camera: waacking (fast arm whips, turns, wide
stances), 8.0 s, 640×480 (landscape), 30 fps, H.264, with the clip's music (AAC stereo).

- Source: "Waacking.ogv" on Wikimedia Commons, https://commons.wikimedia.org/wiki/File:Waacking.ogv
  (a clip of THE COVE S.1 E.3, Axelle "Ebony" Munezero, 3:30–3:58 of https://vimeo.com/122690169).
- Author: JA'KNOWS.
- Licence: Creative Commons Attribution 3.0 (CC BY 3.0), https://creativecommons.org/licenses/by/3.0/
- Changes: seconds 16–24 cut out, cropped to the left 960×720 (leaving out the dancer's reflection in a mirror),
  scaled to 640×480, re-encoded from Theora/Vorbis to H.264/AAC:
  `ffmpeg -ss 16 -t 8 -i Waacking.ogv -vf "crop=960:720:0:0,scale=640:480:flags=lanczos,fps=30" -c:v libx264
  -profile:v main -pix_fmt yuv420p -crf 24 -preset slow -c:a aac -b:a 96k -ac 2 -movflags +faststart dance-waacking.mp4`

Used by `tests/e2e/run.mjs` as the landscape file uploaded in video mode (its music must play and be recorded).

Neither clip is shipped in the app.
