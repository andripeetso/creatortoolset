# The Creator Toolset helper in a container, for a NAS (a TrueNAS custom app): it keeps copies of a Media Library in a
# dataset mounted at /copies. The standard library only: no speech models here. README.md → "Docker".
#   CT_SERVER     the server's address
#   CT_PAIR_CODE  the one-time code from Settings → Computers → Add computer (used once, on the first start)
#   CT_FOLDERS    the folders it may read and write for the server, ":"-separated (default /copies; README "Folders")
# Bind-mount a folder of the host at /data (its token, mode 0600) and the dataset at /copies; pick /copies in Add copy.
# /data must be a bind mount: in an anonymous volume the pairing is lost when the container is made again.
# It runs as PUID:PGID (default 568:568, the TrueNAS apps user), never root, so the copy's files are that user's:
#   docker build --build-arg PUID=1000 --build-arg PGID=1000 .   (or docker run --user 1000:1000)
FROM python:3.12-slim
ARG PUID=568
ARG PGID=568
ADD helper.py /app/helper.py
RUN mkdir -p /data && chown "$PUID:$PGID" /data
ENV CT_HELPER_HOME=/data PYTHONUNBUFFERED=1 CT_FOLDERS=/copies
USER $PUID:$PGID
CMD ["sh", "-c", "test -f /data/config.json || python /app/helper.py pair \"$CT_SERVER\" \"$CT_PAIR_CODE\" || exit 1; exec python /app/helper.py run"]
