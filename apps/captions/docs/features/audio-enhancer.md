# Audio Enhancer

### Audio Enhancer (`/enhance`)

Each run picks an engine (`?engine=` on upload and re-run, stored as `meta.engine`). Every result is levelled by the same loudnorm to -15 LUFS.

- `nvidia`: NVIDIA Studio Voice on NVIDIA's hosted API (`NVIDIA_API_KEY`; `api/lib/nvidia-voice.ts` speaks gRPC over node:http2 with no generated code, in 5-minute pieces, and shifts out the model's ~145 ms delay per piece). It runs in this server process.
- `elevenlabs`: the ElevenLabs Voice Isolator (`ELEVENLABS_API_KEY`), keeps the voice as it is and strips noise and music.

Both engines run on the session owner's own key (Settings → My API keys); the server's key is used only for the platform admin. A run with no key for its engine is parked as `needs_key` with the key to add, not refused: the session keeps its audio, and "Try again" runs it once the key is saved.

Who gets what: everyone starts on NVIDIA (the default); admins can add a second pass. The picker shows every engine by its name. What a user can't run is locked, with the reason (the key to add). The last pick is remembered (`enhance.engine`).

Re-enhancing a file sits under "Edit enhancement": compact engine chips, a second pass, then "Enhance again with …". Admins can add a second pass (`?then=`, another engine; `meta.chain`, `meta.step`). Each pass's output is the next one's input (`pass-<n>.wav`). Two rebuilding engines in a row stack their artifacts, so the page recommends ElevenLabs first, then NVIDIA.

Strength is for everyone, guests included. The player plays the original and the result together through Web Audio gains (the original leads, the result is held within 50 ms of it), and the slider sets the blend live. `PUT /:id/mix` keeps the choice. A download under 100 % is that blend (`blend-<pct>.m4a`, `?mix=`, made once per result and levelled again). `source.m4a` is levelled like the result at upload, so Before/After and the slider change the sound, not the volume.
