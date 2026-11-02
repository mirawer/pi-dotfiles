#!/usr/bin/env python3
"""Fetch YouTube video titles, descriptions and transcripts via yt-dlp.

v2 — built to survive YouTube rate limiting (HTTP 429):

- ONE yt-dlp metadata call per video. The caption file is then fetched
  directly from the timedtext URL found in that metadata, instead of a
  second full yt-dlp extraction (v1 made 2 extractions per video).
- Exponential backoff retry on HTTP 429 for both steps.
- Batch mode: pass N URLs, get N JSON files (--out-dir), with a polite
  delay between videos. Existing files are skipped (cache), so re-running
  after a failure only fetches what's missing.
- Single-URL mode without --out-dir keeps the old behavior: JSON on stdout.

Usage:
  fetch_transcript.py URL [URL ...] [--out-dir DIR] [--delay SECONDS]
"""
import sys
import os
import glob
import json
import time
import shutil
import tempfile
import subprocess
import urllib.request
import urllib.error

MAX_RETRIES = 4
BACKOFF_BASE = 20  # seconds: waits are 20, 40, 80, 160


def log(msg):
    print(msg, file=sys.stderr)


def backoff_sleep(attempt, what):
    wait = BACKOFF_BASE * (2 ** attempt)
    log(f"  HTTP 429 on {what}; retrying in {wait}s "
        f"(attempt {attempt + 1}/{MAX_RETRIES})...")
    time.sleep(wait)


def get_metadata(url):
    cmd = ["yt-dlp", "--dump-json", "--no-warnings", "--skip-download", url]
    for attempt in range(MAX_RETRIES + 1):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return json.loads(result.stdout)
        if "429" in result.stderr and attempt < MAX_RETRIES:
            backoff_sleep(attempt, "metadata")
        else:
            log(f"Error executing yt-dlp: {result.stderr.strip()[:300]}")
            return None
    return None


def pick_caption_url(info):
    """Return (timedtext_url, lang, is_auto) for the best English json3 track."""
    subs = info.get("subtitles") or {}
    auto = info.get("automatic_captions") or {}
    preferred = ["en", "en-US", "en-GB"]

    def find_json3(tracks):
        for fmt in tracks:
            if fmt.get("ext") == "json3" and fmt.get("url"):
                return fmt["url"]
        return None

    for lang in preferred + sorted(subs):
        if lang in subs and (lang in preferred or lang.startswith("en")):
            u = find_json3(subs[lang])
            if u:
                return u, lang, False
    for lang in preferred + sorted(auto):
        if lang in auto and (lang in preferred or lang.startswith("en")):
            u = find_json3(auto[lang])
            if u:
                return u, lang, True
    return None


def fetch_json3(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"})
    for attempt in range(MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < MAX_RETRIES:
                backoff_sleep(attempt, "captions")
            else:
                log(f"Error fetching captions: HTTP {e.code}")
                return None
        except Exception as e:
            log(f"Error fetching captions: {e}")
            return None
    return None


def download_subtitle_fallback(url, lang, is_auto, outdir):
    """Old-style fallback: yt-dlp downloads the json3 file itself."""
    cmd = [
        "yt-dlp", "--skip-download", "--no-warnings",
        "--sub-format", "json3", "--sub-langs", lang,
        "--write-auto-subs" if is_auto else "--write-subs",
        "-o", os.path.join(outdir, "%(id)s.%(ext)s"),
        url,
    ]
    for attempt in range(MAX_RETRIES + 1):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            matches = glob.glob(os.path.join(outdir, "*.json3"))
            if matches:
                with open(matches[0], "r", encoding="utf-8") as f:
                    return json.load(f)
            return None
        if "429" in result.stderr and attempt < MAX_RETRIES:
            backoff_sleep(attempt, "captions (fallback)")
        else:
            log(f"Fallback subtitle download failed: "
                f"{result.stderr.strip()[:300]}")
            return None
    return None


def extract_text_from_json3(data):
    text_parts = []
    for event in data.get("events", []):
        for seg in event.get("segs", []) or []:
            text = seg.get("utf8", "")
            if text.strip() and text != "\n":
                text_parts.append(text.strip())
    return " ".join(text_parts)


def process_video(url, out_dir=None):
    """Fetch one video. Returns the output dict, or None on failure."""
    info = get_metadata(url)
    if info is None:
        return None
    vid = info.get("id", "unknown")
    title = info.get("title", "Unknown_Title")

    if out_dir:
        out_path = os.path.join(out_dir, f"{vid}.json")
        if os.path.exists(out_path):
            log(f"[{vid}] cached, skipping: {title}")
            with open(out_path, "r", encoding="utf-8") as f:
                return json.load(f)

    pick = pick_caption_url(info)
    if pick is None:
        log(f"[{vid}] No English subtitles found: {title}")
        return None
    cap_url, lang, is_auto = pick

    log(f"[{vid}] {title} — fetching {'auto ' if is_auto else ''}captions ({lang})...")
    data = fetch_json3(cap_url)
    if data is None:
        tmpdir = tempfile.mkdtemp(prefix="yt-transcript-")
        try:
            data = download_subtitle_fallback(url, lang, is_auto, tmpdir)
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)
    if data is None:
        return None

    output = {
        "id": vid,
        "title": title,
        "description": info.get("description"),
        "transcript": extract_text_from_json3(data),
    }
    if out_dir:
        out_path = os.path.join(out_dir, f"{vid}.json")
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2)
        log(f"[{vid}] saved to {out_path}")
    return output


def main():
    args = sys.argv[1:]
    out_dir = None
    delay = 5.0
    urls = []
    i = 0
    while i < len(args):
        if args[i] == "--out-dir" and i + 1 < len(args):
            out_dir = args[i + 1]
            i += 2
        elif args[i] == "--delay" and i + 1 < len(args):
            delay = float(args[i + 1])
            i += 2
        else:
            urls.append(args[i])
            i += 1

    if not urls:
        print("Usage: fetch_transcript.py URL [URL ...] "
              "[--out-dir DIR] [--delay SECONDS]", file=sys.stderr)
        sys.exit(1)

    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    results = []
    for n, url in enumerate(urls):
        if n > 0 and delay > 0:
            time.sleep(delay)
        results.append(process_video(url, out_dir))

    if out_dir is None and len(urls) == 1:
        if results[0] is None:
            sys.exit(1)
        print(json.dumps(results[0], indent=2))
    else:
        ok = sum(1 for r in results if r is not None)
        log(f"Done: {ok}/{len(urls)} succeeded.")
        if ok < len(urls):
            sys.exit(1)


if __name__ == "__main__":
    main()
