# Creator Toolset helper

A Linux computer of yours (with or without an NVIDIA graphics card) turns speech into text for your Creator Toolset
server, with models it downloads itself. Today it makes the Media Library's transcripts when Settings → AI → Voice
runs them on your computers.

The server hands these files out itself, at `<server>/helper/`, so the computer needs nothing but the server's
address.

## Install

In Creator Toolset: Settings → Devices → Add a computer → Linux. It shows a one-time code (10 minutes, works once) and
this command, to run on the Linux computer as the user it should run under:

```sh
curl -fsSL <server>/helper/install.sh | sh -s -- <server> <code>
```

It needs Python 3 and curl (and `uv` or `python3-venv`). It puts everything in `~/.local/share/creator-toolset-helper`
(`CT_HELPER_HOME` to change it), pairs this computer with your account, installs faster-whisper and onnx-asr in its own
virtual environment (with the CUDA libraries when `nvidia-smi` is there) and starts the systemd user service
`creator-toolset-helper`. To keep it running while you are logged out: `loginctl enable-linger $USER`.

By hand: copy `helper.py` and `requirements.txt`, make a virtual environment with them, then
`python helper.py pair <server> <code>` and `python helper.py run`.

## What it does

- Keeps a long poll open to the server, also while it downloads or transcribes (a computer silent for 40 s is offline).
- Downloads only the models you press Download for under Settings → AI → Voice, from the model's Hugging Face
  conversion, into `models/<id>/`, and deletes the ones you remove. Nothing else is deleted.
- Runs Whisper (large-v3 turbo, large-v3) with faster-whisper: on the graphics card in float16, else on the CPU in int8.
  Parakeet TDT 0.6B v3 (English) with onnx-asr.
- Sends back the words with their times. One transcript at a time.

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
