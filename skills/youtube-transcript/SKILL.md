---
name: youtube-transcript
description: Fetch the transcript and title of a YouTube video as JSON. Use when the user provides a YouTube URL and you need the spoken content (captions) for analysis, summarization, quoting, or search.
---

# YouTube Transcript

Fetches a YouTube video's title, full description/bio, and full transcript by pulling captions via `yt-dlp`. Prefers manual English subtitles, falls back to auto-generated English.

## Requirements

- `yt-dlp` on PATH (`brew install yt-dlp`)
- Python 3

## Usage

Single video (JSON on stdout):

```bash
python3 ~/.pi/agent/skills/youtube-transcript/fetch_transcript.py "<youtube_url>"
```

Batch mode (one `<video_id>.json` per video, cached — re-running only fetches what's missing):

```bash
python3 ~/.pi/agent/skills/youtube-transcript/fetch_transcript.py "<url1>" "<url2>" ... --out-dir /tmp/yt-batch --delay 5
```

The script makes only ONE yt-dlp metadata call per video (the caption file is fetched directly from the timedtext URL in the metadata) and retries with exponential backoff (20s→160s) on HTTP 429. Prefer batch mode over a shell loop — it spaces requests politely and skips already-fetched videos.

## Output

Prints a JSON object to stdout (single mode) or writes one file per video (batch mode):

```json
{
  "id": "video id",
  "title": "Video title",
  "description": "full description / bio text as a single string, or null if the video has no description",
  "transcript": "full transcript text as a single string"
}
```

Progress/info logs go to stderr. On failure (no English captions, network error, bad URL), the script exits non-zero with a message on stderr.

## Notes

- Only English captions are attempted (`en`, `en-US`, `en-GB`, then any `en*`). Manual captions are preferred over auto-generated.
- Transcript is plain text with timing/formatting stripped — not timestamped.
- `description` is the raw video description from metadata (contains links, timestamps, chapters, etc.). It may be `null` for videos that have none.
- For non-English videos or videos with captions disabled, the script will fail; consider `video_extract` with a Gemini prompt as a fallback.
