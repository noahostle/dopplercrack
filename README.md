# Dopplercrack

Standalone aircraft-audio location workspace: React interface, Node API and bounded C search engine. Runs independently of Signalglass.

## Workflow

1. Upload audio/video or paste a YouTube link. YouTube loads title/duration first; select timestamps before **Download & analyze audio**. Uploaded files analyze automatically. Each continuous portion is 8 seconds–30 minutes; there is no file-size cap.
2. Select countries on the map or by search. Speech-language suggestions highlight countries without selecting them for you.
3. Enter the **original recording start** date, time and timezone. Your browser's timezone is the default; embedded UTC timestamps, result times and archive coverage are displayed in the selected zone. Enable **Search a start-time range** for uncertain times: for example, every 5 seconds between **07:00–10:00 on 25–27 October**. Each trial is a possible video start, with the selected clip offset added automatically.
4. Check the red/green **SYSTEM READY** console at the top, lift the glass cover, then press the red **GO** button. The cover only budges while any check is incomplete; it opens when every check passes. Opening it does not start a search, and Escape closes it again. Each unmet condition explains what to do. The spectrogram and measured Doppler paths appear after audio analysis; inspect each curve or toggle the overlay without changing the search. Flight history and terrain load automatically; brightness scoring and the silence heuristic are always enabled.
5. Explore the heatmap and ten strongest **possible acoustic matches**. City/state/country labels come from the nearest settlement in the offline GeoNames gazetteer; exact candidate coordinates remain visible. Click a result for Street View when a Maps browser key is configured and imagery exists; otherwise the viewer shows satellite imagery.

No track CSV upload, manual acoustic approval, receiver-height choice or curve review is needed. Recordings without sufficiently coherent moving tones return **insufficient signal** instead of starting an unsupported location search. Wide dates can require large downloads and long searches; progress and an ETA update as batches complete.

## Start

```sh
cd dopplercrack
npm run setup
npm start
```

Open **http://127.0.0.1:3857**. On this migrated installation, dependencies and the interface are already installed/built, so `npm start` is sufficient. `npm run dev` enables frontend hot reload at the same address.

Setup requires Node.js 22.13+, a C compiler, Python 3 with venv, FFmpeg/ffprobe, CMake, Git and curl. Windows uses WSL. On macOS install Xcode command line tools and FFmpeg/CMake; Ubuntu/WSL packages are `build-essential python3-venv ffmpeg cmake git curl`. `npm run native:install -- --no-language` builds without installing the optional speech model.

Setup also installs the offline GeoNames locality index (about 7 MiB). It is reusable reference data, not recording or analysis history. Run `runtime/python/bin/python scripts/prepare-doppler-places.py --refresh` from Linux/macOS/WSL to update it; lookups require no API key or network call. [Data sources and licenses](public/doppler/SOURCES.md).

## Project layout

- `app/`, `components/`, `lib/`, `src/`: standalone interface and protocol types.
- `server/`: browser gateway, private authenticated runner, media and search pipeline.
- `native/`: C search engine and numerical bounds.
- `scripts/`: installers, checks and world-data preparation.
- `data/`: local flight archives/imports, ignored by Git.
- `runtime/`: installed tools, language model, terrain and temporary session files, ignored by Git.
- `outputs/`: development verification artifacts, ignored by Git.

ADS-B and terrain remain reusable caches. Recordings and results have no persistent job history: every newly loaded recording is analyzed afresh. Working media lives only for the current session and is deleted on replacement, tab close, server shutdown, or after 30 minutes without a heartbeat. A restart removes abandoned workspaces. YouTube source downloads are removed immediately after decoding. Export or attach results explicitly if you want to keep them.

Optional limits and the Google Maps browser key belong in this project's `.env.local` (see `.env.example`). The default UI port is 3857; `DOPPLER_PORT` changes it. The UI uses a private loopback runner with an automatically generated secret, which stays out of browser responses.

## Signalglass integration

Signalglass's `/doppler` route embeds this independent application and relays case results with origin/source checks. Its development launcher reuses a running instance at port 3857 or starts one automatically. A different local instance can be selected with Signalglass's `DOPPLER_APP_ENDPOINT`. Dopplercrack itself never imports Signalglass or requires its database, AI endpoint, packages or configuration.

## Checks and methodology

```sh
npm test
npm run check
npm run check:discovery
npm run doppler:check
npm run build
npm run check:ui
```

The optional browser check needs Chrome. `npm run check:reference -- --download` checks two excerpts of Colsto's public challenge; it does not validate a location. `node scripts/check-doppler-media.mjs --youtube` exercises a real bounded download. No check calls an AI endpoint.

[Workflow and formats](DOPPLERCRACK.md) · [0.5 changes and validation](DOPPLERCRACK_V05.md) · [Mathematics](DOPPLERCRACK_MATH.md) · [Earlier performance work](DOPPLERCRACK_PERFORMANCE.md)

Results are unvalidated location hypotheses. A numerical fit does not establish a recording location.
