import { describe, expect, it } from "vitest";
import { SKILL_LIMITS, checkSkill, oneLine, parseSkillFile, pickSkillFile } from "./skills";

const FILE = `---
name: card-style
description: >
  Use when making an animated card,
  or when asked about how cards look.
allowed-tools: Bash(*), Write
model: some-model
hooks:
  PreToolUse:
    - command: ./scripts/setup.sh
---
# Cards

Round corners. Slow moves.
`;

describe("a dropped skill file", () => {
  it("gives its name, the line that says when to use it and its body: nothing else in its header is read", () => {
    expect(parseSkillFile(FILE, "SKILL.md")).toEqual({
      name: "card-style",
      when: "Use when making an animated card, or when asked about how cards look.",
      body: "# Cards\n\nRound corners. Slow moves.",
    });
    const kept = JSON.stringify(parseSkillFile(FILE));
    for (const dropped of ["allowed-tools", "Bash", "model", "hooks", "setup.sh"]) expect(kept).not.toContain(dropped);
  });

  it("with no header is all body, named by its first heading or its file name", () => {
    expect(parseSkillFile("# Hook rules\n\nOpen on the result.", "notes.md")).toEqual({ name: "Hook rules", when: "", body: "# Hook rules\n\nOpen on the result." });
    expect(parseSkillFile("Open on the result.", "/skills/hook rules.txt")).toEqual({ name: "hook rules", when: "", body: "Open on the result." });
    expect(parseSkillFile("Open on the result.", "SKILL.md")).toEqual({ name: "", when: "", body: "Open on the result." });
  });

  it("reads a quoted or one-line header value, and Windows line ends", () => {
    expect(parseSkillFile(`---\r\nname: "Hooks"\r\ndescription: 'When writing a hook'\r\n---\r\nBody.\r\n`)).toEqual({ name: "Hooks", when: "When writing a hook", body: "Body." });
  });

  it("that is not text is refused: a picture, an archive, a program", () => {
    expect(parseSkillFile("PK\u0003\u0004\u0000\u0000binary")).toEqual({ error: "That file is not text." });
    expect(parseSkillFile("\uFFFD".repeat(9))).toEqual({ error: "That file is not text." });
    expect(parseSkillFile("x".repeat(SKILL_LIMITS.file + 1))).toEqual({ error: "That file is too long to be a skill." });
  });

  it("from a dropped folder only the skill's own text file is picked: scripts and the rest are never read", () => {
    expect(pickSkillFile(["cards/scripts/setup.sh", "cards/SKILL.md", "cards/reference/more.md", "cards/logo.png"])).toBe("cards/SKILL.md");
    expect(pickSkillFile(["a/deep/SKILL.md", "a/skill.md"])).toBe("a/skill.md");
    expect(pickSkillFile(["cards/run.py", "cards/notes.txt"])).toBe("cards/notes.txt");
    expect(pickSkillFile(["cards/one.md", "cards/two.md"])).toBeNull();
    expect(pickSkillFile(["cards/run.sh", "cards/tool.py"])).toBeNull();
  });
});

describe("what is kept of a skill", () => {
  it("a name and a line are one line each, and a body keeps its line breaks and loses control characters", () => {
    expect(oneLine(" a\n\nb\tc\u2028d\u200Be ")).toBe("a b c d e");
    expect(checkSkill({ name: " Hooks\n", when: "When\nwriting", body: "One\r\nTwo\u0000\u0007\u2029Three\t!" })).toEqual({ skill: { name: "Hooks", when: "When writing", body: "One\nTwo\nThree\t!" } });
  });

  it("says what is missing or too long", () => {
    expect(checkSkill({ when: "x", body: "x" })).toEqual({ error: "Give the skill a name." });
    expect(checkSkill({ name: "x", body: "x" })).toEqual({ error: "Say when to use it, in one line." });
    expect(checkSkill({ name: "x", when: "x", body: 7 })).toEqual({ error: "The skill has no text yet." });
    expect(checkSkill({ name: "x", when: "w".repeat(SKILL_LIMITS.when + 1), body: "x" })).toEqual({ error: "That line takes up to 160 characters. This one has 161." });
  });
});
