# Video Octopus

A local video editor with Claude built in. Record your screen, camera and mic, clean up the take, cut it from the transcript, plan the scenes and export, all on your own computer, with **your own Claude Code and your own Claude plan** doing the editing work beside you.

## What it does

- **Record**: screen, camera and mic in Chrome or Edge, with a live preview. Paste a script and it scrolls while you record, or open it in its own window for a teleprompter.
- **Clean up**: transcribes on your computer (Whisper), takes out fillers, long pauses and earlier retakes, and checks every join for clipped words.
- **Cut**: edit by deleting words in the transcript or dragging on the waveform, then lock the cut.
- **Plan and build**: Claude writes a production sheet scene by scene, then builds the visuals with the skills in your studio. You review them scene by scene.
- **Shots and zooms**: split the video into shots, give each one its own layout, zoom into an area, add transitions.
- **Export**: the finished MP4, every layer as its own file for another editor, or just the audio.

Project types: YouTube tutorial, Faceless explainer, Short and Product explainer. Each type has its own frame shape and steps.

## Get started

You need:
- a Mac or a Windows PC;
- [Node.js](https://nodejs.org) 20 or newer;
- [Claude Code](https://claude.com/claude-code), signed in;
- Chrome or Edge, for recording.

Setup checks the rest (ffmpeg, Python for the local transcription) and says how to install anything that's missing.

```bash
git clone https://github.com/Barty-Bart/video-octopus.git
cd video-octopus
./start.sh
```

On Windows, run `start.cmd` instead. Then open http://127.0.0.1:4800 if it doesn't open by itself. There are no npm packages to install.

On the first run, **Setup** checks your computer and offers **Create my studio**: a folder for your projects, recordings and library, with starter skills (transcribe, rough cut, join check, production sheet, talking-head zoom) and the Cut Editor. You can add motion graphics skills from a GitHub repo in Setup.

## Your stuff stays yours

Your videos, projects and library live in your studio folder. The app's own settings, chat logs and keys live in `local/`, which git ignores. Nothing leaves your computer except what Claude Code sends to Claude (or to another model source, if you pick one in Settings).

## Status

In active development: expect changes.
