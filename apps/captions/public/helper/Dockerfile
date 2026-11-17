# The Creator Toolset helper in a container, for a NAS (a TrueNAS custom app): it keeps copies of a Media Library in a
# dataset mounted at /copies. The standard library only: no speech models here. README.md → "Docker".
#   CT_SERVER     the server's address
#   CT_PAIR_CODE  the one-time code from Settings → Computers → Add computer (used once, on the first start)
# Mount a volume at /data (its token, mode 0600) and the dataset at /copies; pick /copies in Add copy.
FROM python:3.12-slim
ADD helper.py /app/helper.py
ENV CT_HELPER_HOME=/data PYTHONUNBUFFERED=1
VOLUME ["/data"]
CMD ["sh", "-c", "test -f /data/config.json || python /app/helper.py pair \"$CT_SERVER\" \"$CT_PAIR_CODE\" || exit 1; exec python /app/helper.py run"]
