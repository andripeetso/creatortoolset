# dmgbuild settings for the download's window (release.sh): the app on the left, an arrow, Applications on the right,
# on background.png (with background@2x.png for Retina). Icon centres match the arrow drawn in background.html
# (its ends sit at x 250 and 384, y ~196).
import os

app = defines.get("app")
format = "UDZO"
files = [app]
symlinks = {"Applications": "/Applications"}
icon = os.path.join(app, "Contents/Resources/AppIcon.icns")
background = os.path.join(defines.get("here"), "background.png")
window_rect = ((200, 120), (640, 428))  # Finder counts the title bar: 428 outer = 400 content
icon_size = 96
text_size = 12
show_status_bar = show_tab_view = show_toolbar = show_pathbar = show_sidebar = False
default_view = "icon-view"
icon_locations = {os.path.basename(app): (175, 196), "Applications": (465, 196)}
