# Dance sources

The built-in real-video dances in `public/dances/` are MediaPipe pose tracks taken from these videos. The videos
themselves are other people's work: they stay in `.cache/dances/` (not committed, never shipped); only the landmarks
are kept, with the credit in each track's `source` field.

Add or rebuild one with `node tools/dances/add.mjs <id>` (entries in `tools/dances/dances.json`; times are seconds in
the source video).

| id | dance | video | performer | used (loop) | searched window |
|----|-------|-------|-----------|-------------|-----------------|
| gouxiong | 狗熊哆嗦毛 | [狗熊哆嗦毛 原教學片](https://www.youtube.com/watch?v=bUBPJP7N9XA) (YouTube re-upload by K kamamrider of the bilibili upload of 山东秧歌舞蹈（鼓子）训练教材) | 明文军, 鼓子秧歌主讲老师 | 552.68–554.14 | 551.30–554.75 |

## Notes

- **gouxiong**: the 狗熊哆嗦毛 chapter of the teaching video (from 9:05), 明文军's own full-speed demonstration in the
  one wide tripod shot before the close-up (9:14.8). One full cycle (straddle with the arms over the head, arms flung
  out, lunge with the arms up, deep side lean with the arms out, step back) repeats every ~1.45 s; the loop is one
  cycle. The same chapter shows a younger dancer repeating the move for 7 s (559.4–566.6), not used.
