# Creator Toolset helper

A Linux computer of yours (with or without an NVIDIA graphics card) turns speech into text for your Creator Toolset
server, with models it downloads itself. Today it makes the Media Library's transcripts when Settings → AI → Voice
runs them on your computers, and it keeps copies of your Media Library in a folder on it (Settings → Media Library →
Copies).

The server hands these files out itself, at `<server>/helper/`, so the computer needs nothing but the server's
address.

## Install

In Creator Toolset: Settings → Computers → Add computer → Linux. It shows a one-time code (10 minutes, works once) and
this command, to run on the Linux computer as the user it should run under:

```sh
curl -fsSL <server>/helper/install.sh | sh -s -- <server> <code>
```

It needs Python 3 and curl (and `uv` or `python3-venv`). It puts everything in `~/.local/share/creator-toolset-helper`
(`CT_HELPER_HOME` to change it), pairs this computer with your account, installs faster-whisper and onnx-asr in its own
virtual environment (with CUDA 12's cuBLAS and cuDNN when `nvidia-smi` is there) and starts the systemd user service
`creator-toolset-helper`. To keep it running while you are logged out: `loginctl enable-linger $USER`.

By hand: copy `helper.py` and `requirements.txt`, make a virtual environment with them, then
`python helper.py pair <server> <code>` and `python helper.py run`.

## Docker (a NAS that keeps a copy)

On a NAS (a TrueNAS custom app, or any Docker host) the helper keeps copies of your Media Library and nothing else:
the image has the standard library only, no speech models. Build it from this folder's `Dockerfile` and `helper.py`:

```sh
mkdir helper && cd helper && curl -fsSL -O <server>/helper/Dockerfile -O <server>/helper/helper.py
docker build -t creator-toolset-helper .
docker run -d --restart unless-stopped --name creator-toolset-helper \
  -e CT_SERVER=<server> -e CT_PAIR_CODE=<code> \
  -v /mnt/tank/helper:/data -v /mnt/tank/library-copy:/copies creator-toolset-helper
```

`/data` keeps its token (`config.json`, mode 0600): the code is used once, on the first start. Mount the dataset the
copy goes in at `/copies`, then in Creator Toolset: Settings → Media Library → Copies → Add copy → this computer →
`/copies`. Once the computer is removed in Settings → Devices the helper exits (status 3) on each start: stop the
container, empty `/data` and start it again with a new code.

## What it does

- Keeps a long poll open to the server, also while it downloads or transcribes (a computer silent for 40 s is offline).
- Downloads only the models you press Download for under Settings → AI → Voice, from the model's Hugging Face
  conversion, into `models/<id>/`, and deletes the ones you remove. Nothing else is deleted.
- Runs Whisper (large-v3 turbo, large-v3) with faster-whisper: on the graphics card in float16, else on the CPU in int8.
  Parakeet TDT 0.6B v3 (English) with onnx-asr, on the CPU.
- Sends back the words with their times. One transcript at a time.
- A copy: one file at a time, each written as `.<name>.partial`, checked against the library's checksum and renamed. A
  newer version moves the older one into `.versions/`; a file of yours in the way stays and the new one goes beside it
  as `<name> 2`. `.creatortoolset-copy.json` at the folder's top says which copy it is (without it the copy asks to be
  reconnected); `.creatortoolset-copy.lock` keeps a second writer out. Nothing in the folder is ever deleted but its own
  partials. Copies need no speech libraries.

## Logs, stop, remove

```sh
journalctl --user -u creator-toolset-helper -f
systemctl --user disable --now creator-toolset-helper
rm ~/.config/systemd/user/creator-toolset-helper.service
rm -r ~/.local/share/creator-toolset-helper
```

Removing the computer in Settings → Devices ends its token: the helper stops and asks to be paired again.

## Licences of the models

Whisper large-v3 turbo by OpenAI (MIT), Whisper large-v3 by OpenAI (Apache-2.0), Parakeet TDT 0.6B v3 by NVIDIA
(CC-BY-4.0). The helper downloads community conversions of them for its runtimes: deepdml/faster-whisper-large-v3-turbo-ct2,
Systran/faster-whisper-large-v3, istupakov/parakeet-tdt-0.6b-v3-onnx.
