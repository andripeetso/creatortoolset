#!/bin/sh
# Installs the Creator Toolset helper for this user and pairs it with your server:
#   curl -fsSL <server>/helper/install.sh | sh -s -- <server> <code>
# The code comes from Settings → Devices → Add a computer → Linux. Everything goes in $CT_HELPER_HOME
# (default ~/.local/share/creator-toolset-helper) plus one systemd --user unit, creator-toolset-helper.service.
set -eu
SERVER=${1:?usage: install.sh <server> <code>}
CODE=${2:?usage: install.sh <server> <code>}
SERVER=${SERVER%/}
DIR=${CT_HELPER_HOME:-$HOME/.local/share/creator-toolset-helper}
mkdir -p "$DIR"
for f in helper.py requirements.txt creator-toolset-helper.service; do
  curl -fsSL "$SERVER/helper/$f" -o "$DIR/$f"
done
# pair first: the code lasts ten minutes, the models' libraries take longer to install
python3 "$DIR/helper.py" pair "$SERVER" "$CODE"
# a Python the speech libraries have wheels for (3.10 to 3.12): uv brings one when the system's is newer
if command -v uv >/dev/null 2>&1; then
  uv venv -q --allow-existing --python 3.12 "$DIR/venv"
  PIP="uv pip install -q --python $DIR/venv/bin/python"
else
  python3 -m venv "$DIR/venv"
  PIP="$DIR/venv/bin/pip install -q"
fi
$PIP -r "$DIR/requirements.txt"
if command -v nvidia-smi >/dev/null 2>&1; then
  # the graphics card: ONNX Runtime with CUDA 12 and cuDNN 9, which faster-whisper's CTranslate2 uses too
  $PIP "onnxruntime-gpu[cuda,cudnn]"
fi
mkdir -p "$HOME/.config/systemd/user"
sed "s|@DIR@|$DIR|g" "$DIR/creator-toolset-helper.service" > "$HOME/.config/systemd/user/creator-toolset-helper.service"
systemctl --user daemon-reload
systemctl --user enable --now creator-toolset-helper
echo "Running. It shows up in Settings → Devices; logs: journalctl --user -u creator-toolset-helper -f"
echo "To keep it running while you are logged out: loginctl enable-linger $USER"
