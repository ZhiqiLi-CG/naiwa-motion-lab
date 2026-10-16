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

Used by `tests/e2e/run.mjs` as Chrome's fake webcam (converted to y4m in `.cache/e2e/` at test time) and as the file
uploaded in video mode. Not shipped in the app.
