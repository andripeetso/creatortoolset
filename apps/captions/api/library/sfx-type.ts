import type { DatabaseSync } from "node:sqlite";
import { SOUNDS } from "../../contracts/library";
import { SFX_TYPES, type SfxType } from "../../contracts/sfx";

// The type of a sound effect from its file name and its length. No AI: a word in the name that names a type wins; else
// the length decides between a click and a pop, and a longer sound with no such word has no type.

const WORDS: Record<SfxType, string[]> = {
  whoosh: ["whoosh", "swoosh", "woosh", "wind", "sweep", "flyby", "thruster", "rush"],
  swipe: ["swipe", "swish", "scroll", "slide", "drag", "flick"],
  pop: ["pop", "bubble", "bong", "blip", "plop", "boop", "drop"],
  click: ["click", "tick", "tap", "press", "select", "switch", "toggle", "button", "mouse"],
  hit: ["hit", "impact", "punch", "thud", "slam", "smack", "knock", "bang", "crunch", "explosion", "boom", "kick", "chop"],
  riser: ["riser", "rise", "uplift", "charge", "swell", "tension", "build"],
  ding: ["ding", "bell", "chime", "glass", "pluck", "confirm", "confirmation", "success", "ping"],
  glitch: ["glitch", "static", "distort", "zap", "laser", "crackle"],
  typing: ["typing", "typewriter", "keyboard", "keystroke", "keys"],
  camera: ["camera", "shutter", "snap", "photo", "flash"],
  paper: ["paper", "page", "book", "flip", "cloth", "fabric", "crumple", "rustle"],
  notification: ["notification", "notify", "alert", "error", "question", "message", "buzz", "warning"],
  transition: ["transition", "transit", "door", "portal"],
};

/** The words of a file name: camelCase, digits and punctuation split it, lower case. */
export function nameWords(name: string): string[] {
  return name
    .replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/** The type a sound effect gets from its name (a word that is or starts a type word, length 4+) and its length in seconds. */
export function sfxTypeOf(name: string, seconds: number): SfxType | null {
  for (const w of nameWords(name)) {
    for (const t of SFX_TYPES) {
      if (WORDS[t].some((k) => w === k || (k.length >= 4 && w.startsWith(k)))) return t;
    }
  }
  if (seconds <= 0.3) return "click";
  if (seconds <= 1) return "pop";
  return null;
}

/**
 * A sound effect (tagged `sound effect`, by the ingest or the organizer) with no type tag yet gets one from its title and
 * length, as the app's tag ("ai", which the user can change like any tag). Run once the file is probed.
 */
export function tagSoundType(d: DatabaseSync, versionId: string, title: string, seconds: number): void {
  const a = d
    .prepare("SELECT a.id AS id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?)")
    .get(versionId, SOUNDS.effect.tag) as { id: string } | undefined;
  if (!a || d.prepare(`SELECT 1 FROM asset_tags WHERE asset_id = ? AND tag IN (${SFX_TYPES.map(() => "?").join(", ")})`).get(a.id, ...SFX_TYPES)) return;
  const t = sfxTypeOf(title, seconds);
  if (t) d.prepare("INSERT OR IGNORE INTO asset_tags (asset_id, tag, source) VALUES (?, ?, 'ai')").run(a.id, t);
}
