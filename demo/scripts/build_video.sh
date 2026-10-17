#!/bin/sh
# Full demo build: record → tts → plan → render (2 parts in parallel) → audio → mux.
# Needs the server running on :8788 (npm start), Python 3 with playwright, edge-tts, numpy, scipy, Pillow (raqm).
set -e
cd "$(dirname "$0")/../build"
python3 ../scripts/record.py
python3 ../scripts/tts.py
python3 ../scripts/plan.py
python3 ../scripts/render.py 0 2 & python3 ../scripts/render.py 1 2 & wait
python3 ../scripts/audio.py
printf "file 'part_0.mp4'\nfile 'part_1.mp4'\n" > parts.txt
ffmpeg -v error -y -f concat -safe 0 -i parts.txt -i mix.m4a -map 0:v -map 1:a -c:v copy -c:a copy -shortest -movflags +faststart /tmp/dose_buddy_demo.mp4 && cp /tmp/dose_buddy_demo.mp4 ../dose_buddy_demo.mp4
ffprobe -v error -show_entries format=duration:stream=width,height,codec_name -of compact ../dose_buddy_demo.mp4
