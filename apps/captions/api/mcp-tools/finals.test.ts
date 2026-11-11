import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AssistantView } from "../../contracts/assistant";
import type { Piece } from "../../contracts/library";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "mcp-finals-"));
process.env.APP_SECRET = "mcp-finals-secret";

const { createUser, newApiKey } = await import("../users");
const app = (await import("../boot")).default;
const { libraryDb } = await import("../library/db");
const { indexAsset } = await import("../library/query");
const { addToFinals } = await import("../library/finals");
const { pairDevice } = await import("../lib/devices");
const { saveSettings } = await import("../lib/providers");
const { DEFAULT_SETTINGS } = await import("../../contracts/providers");

// ana keeps her finished videos in Finals and has the assistant; nico is another account on the same server
const ana = createUser("ana", "password1");
const nico = createUser("nico", "password1");
const anaKey = `Bearer ${newApiKey(ana, "full")}`;
const nicoKey = `Bearer ${newApiKey(nico, "full")}`;
const mac = pairDevice("ana", "Ana's Mac");
await saveSettings({ ...structuredClone(DEFAULT_SETTINGS), instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true, device: mac.device.id }] }, "ana");

const json = (body: unknown, extra: Record<string, string> = {}) => ({ headers: { "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const cookieOf = async (username: string) => (await app.request("/api/auth/login", { method: "POST", ...json({ username, password: "password1" }) })).headers.get("set-cookie")!.split(";")[0]!;
const anaCookie = await cookieOf("ana");
const nicoCookie = await cookieOf("nico");
/** One of the site's routes as the person at the screen: what a tool did is checked here, not in the tool's own answer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const site = async (cookie: string, route: string, method = "GET", body?: unknown): Promise<any> =>
  (await app.request(route, { method, ...(body === undefined ? { headers: { cookie } } : json(body, { cookie })) })).json();
const rpc = async (authorization: string, method: string, params: unknown = {}) =>
  ((await (await app.request("/api/mcp", { method: "POST", ...json({ jsonrpc: "2.0", id: 1, method, params }, { authorization }) })).json()) as {
    result: { tools?: Array<{ name: string; description: string }>; content?: Array<{ text: string }>; isError?: boolean };
  }).result;
/** One tool call through POST /api/mcp, against the app's real routes. */
const tool = async (authorization: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(authorization, "tools/call", { name, arguments: args });
  const text = r.content![0]!.text;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { error: !!r.isError, text, value: (r.isError || !/^[[{]/.test(text) ? text : JSON.parse(text)) as any };
};
/** A turn of ana's with the Mac holding its job: the token to call tools as that reply. */
const turn = async (text: string) => {
  expect((await app.request("/api/assistant/turn", { method: "POST", ...json({ text }, { cookie: anaCookie }) })).status).toBe(202);
  const job = (await (await app.request("/api/devices/relay/wait", { method: "POST", ...json({}, { authorization: `Bearer ${mac.token}` }) })).json()) as { id: string; mcp: { token: string } };
  return { token: `Bearer ${job.mcp.token}`, end: () => app.request(`/api/devices/relay/${job.id}/done`, { method: "POST", ...json({ text: "Done." }, { authorization: `Bearer ${mac.token}` }) }) };
};
const lastReply = async () => ((await site(anaCookie, "/api/assistant")) as AssistantView).messages.at(-1)!;

const LIB = (await site(anaCookie, "/api/library")).libraries[0].id as string;
let made = 0;
/** A finished 1080p video in ana's library, sent to Finals as Review sends one: into the piece of that name, as the version of that name. */
async function final(piece: string, version: string | null): Promise<string> {
  const id = `fin-${++made}`;
  const d = libraryDb();
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, filed_roll) VALUES (?, ?, 'video', ?, ?, 'ana', ?, 'none')").run(id, LIB, `${piece} ${version ?? ""}`.trim(), `${id}-v1`, made);
  d.prepare("INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, mime, state, created_by, created_at) VALUES (?, ?, 1, 'k', 1, ?, 'video/mp4', 'ready', 'ana', ?)").run(`${id}-v1`, id, `h-${id}`, made);
  indexAsset(d, id);
  const out = await addToFinals({ owner: "ana", libraryId: LIB, label: piece, item: version, kind: "review", width: 1080, height: 1920 }, { versionId: `${id}-v1` });
  if (!out.ok) throw new Error(out.error);
  // pieces list by when they were made: each one gets its own moment, so the order below is not luck
  d.prepare("UPDATE pieces SET created_at = ? WHERE id = ? AND created_at > 1000").run(made, out.pieceId);
  return out.pieceId;
}
const TUMBLES = await final("Tiny tumbles", "V1A");
await final("Tiny tumbles", "V1B");
await final("Tiny tumbles", "V1C");
const BEACH = await final("Beach cartwheels", null);
const RAINY = await final("Rainy day roll", "V2A");
const BIN = await final("Old warm-up", "V1A");
const KEPT = await final("Tiny Acrobatics trailer", "V1A");

/** The piece as the Finals page reads it. */
const onPage = (id: string, cookie = anaCookie) => site(cookie, `/api/library/${LIB}/pieces/${id}`) as Promise<Piece & { error?: string }>;
const inTrash = async () => ((await site(anaCookie, `/api/library/${LIB}/pieces?trash=1`)).pieces as Piece[]).map((p) => p.label);
const versions = async (id: string) => (await onPage(id)).items.map((i) => i.label);
const [A, B, C] = (await onPage(TUMBLES)).items.map((i) => i.id) as [string, string, string];

describe("finals_pieces", () => {
  it("is listed for the assistant and for an AI key, beside finals_link_session, and takes no name the owner's own plug-in has", async () => {
    const t = await turn("What can you do with my Finals?");
    for (const who of [anaKey, t.token]) {
      const names = (await rpc(who, "tools/list")).tools!.map((x) => x.name);
      expect(names).toEqual(expect.arrayContaining(["finals_link_session", "finals_pieces", "finals_piece_update", "finals_piece_trash"]));
      for (const taken of ["finals_list", "finals_rename", "finals_merge", "finals_order", "finals_upload"]) expect(names).not.toContain(taken);
    }
    await t.end();
  });

  it("lists the pieces newest first with each version's id and name, the winner and the link that opens the piece", async () => {
    const out = (await tool(anaKey, "finals_pieces")).value;
    expect(out.pieces.map((p: { name: string }) => p.name)).toEqual(["Tiny Acrobatics trailer", "Old warm-up", "Rainy day roll", "Beach cartwheels", "Tiny tumbles"]);
    expect(out.note).toBeUndefined();
    expect(out.pieces.at(-1)).toEqual({
      id: TUMBLES,
      name: "Tiny tumbles",
      versions: [{ id: A, name: "V1A" }, { id: B, name: "V1B" }, { id: C, name: "V1C" }],
      link: `http://localhost/finals/${TUMBLES}`,
    });
    // a version nobody named has its id only; the ids are the piece's own, never the library's ids of the files
    expect(out.pieces[3].versions).toEqual([{ id: expect.stringMatching(/^pci_/) }]);
    expect(JSON.stringify(out)).not.toContain("fin-");

    const two = (await tool(anaKey, "finals_pieces", { limit: 2 })).value;
    expect(two.pieces.map((p: { id: string }) => p.id)).toEqual([KEPT, BIN]);
    expect(two.note).toBe("The newest 2 of 5: give limit for more.");
  });

  it("gives one piece in full to the assistant: the winner, each version's post description and where it was posted; its step shows under the reply", async () => {
    await site(anaCookie, `/api/library/${LIB}/pieces/${TUMBLES}/items/${B}`, "PATCH", { winner: true, postDescription: "Three tumbles for a rainy day." });
    await site(anaCookie, `/api/library/${LIB}/pieces/${TUMBLES}/items/${B}/postings`, "POST", { platform: "instagram", url: "https://www.instagram.com/p/TINYTUMBLE1/" });
    const t = await turn("Tell me about Tiny tumbles");
    const out = (await tool(t.token, "finals_pieces", { piece: TUMBLES })).value;
    await t.end();
    expect(out).toEqual({
      id: TUMBLES,
      name: "Tiny tumbles",
      versions: [
        { id: A, name: "V1A" },
        { id: B, name: "V1B", winner: true, post_description: "Three tumbles for a rainy day.", posted: [{ platform: "instagram", url: "https://www.instagram.com/p/TINYTUMBLE1/", at: expect.stringMatching(/^20\d\d-\d\d-\d\d \d\d:\d\d$/) }] },
        { id: C, name: "V1C" },
      ],
      link: `http://localhost/finals/${TUMBLES}`,
    });
    const reply = await lastReply();
    expect(reply.steps).toEqual(["Looking through your Finals"]);
    expect(reply.work).toBeUndefined();
    expect(await tool(anaKey, "finals_pieces", { piece: "pce_nothere" })).toMatchObject({ error: true, text: "Not found, or not this account's." });
  });

  it("gives the id finals_link_session needs, and then says which Workshop session the piece is linked to", async () => {
    const session = (await tool(anaKey, "workshop_new_session", { title: "Rainy day tumbles" })).value;
    const id = (await tool(anaKey, "finals_pieces")).value.pieces.find((p: { name: string }) => p.name === "Rainy day roll").id;
    expect(id).toBe(RAINY);
    expect((await tool(anaKey, "finals_link_session", { session: session.id, piece: id })).value).toEqual({ linked: true });
    const listed = (await tool(anaKey, "finals_pieces")).value.pieces as Array<{ id: string; session?: string }>;
    expect(listed.filter((p) => p.session).map((p) => [p.id, p.session])).toEqual([[RAINY, session.id]]);
    // the post description written in that session (on its piece with words in it) comes with the piece in full
    const doc = (await site(anaCookie, `/api/workshop/sessions/${session.id}/docs`)).find((d: { kind: string }) => d.kind !== "notes");
    expect((await tool(anaKey, "workshop_edit_piece", { session: session.id, piece: doc.id, blocks: [{ text: "Roll through the puddle." }], caption: "Roll through the rain." })).error).toBe(false);
    expect((await tool(anaKey, "finals_pieces", { piece: RAINY })).value).toMatchObject({ id: RAINY, session: session.id, session_post_description: "Roll through the rain." });
    // a version with no post description of its own shows the one the session's writer wrote for it (kept in the session, by the version's id)
    const version = (await onPage(RAINY)).items[0]!.id;
    const file = path.join(process.env.DATA_DIR!, "workshop", "sessions", session.id, "docs", `${doc.id}.json`);
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf-8")), captions: { [version]: { text: "Rain or shine, we roll.", label: "V2A", author: "ai", at: 1 } } }));
    expect((await tool(anaKey, "finals_pieces", { piece: RAINY })).value.versions).toEqual([{ id: version, name: "V2A", post_description: "Rain or shine, we roll." }]);
  });

  it("an account with nothing in Finals gets an empty list, and no Finals folder is made for it", async () => {
    expect((await tool(nicoKey, "finals_pieces")).value).toEqual({ pieces: [] });
    expect((await tool(nicoKey, "finals_piece_trash")).value).toEqual({ trash: [] });
    const lib = (await site(nicoCookie, "/api/library")).libraries[0].id;
    expect((await site(nicoCookie, `/api/library/${lib}/collections`)).collections).toEqual([]);
  });
});

describe("finals_piece_update", () => {
  it("as the assistant: renames the piece, sets the winner, puts the versions in an order and writes one version's name and post description; a card opens the piece", async () => {
    const t = await turn("Tidy up Tiny tumbles");
    const out = (await tool(t.token, "finals_piece_update", { piece: TUMBLES, name: "  Tiny tumbles, spring  ", winner: C, order: [C], version: A, version_name: "Wide", post_description: "The wide one." })).value;
    await t.end();
    expect(out).toEqual({
      id: TUMBLES,
      name: "Tiny tumbles, spring",
      versions: [{ id: C, name: "V1C", winner: true }, { id: A, name: "Wide" }, { id: B, name: "V1B" }],
      link: `http://localhost/finals/${TUMBLES}`,
      changed: ["renamed", "order changed", "version named", "post description saved", "winner set"],
    });
    // the page reads the same
    const piece = await onPage(TUMBLES);
    expect(piece.label).toBe("Tiny tumbles, spring");
    expect(piece.items.map((i) => [i.id, i.label, i.winner, i.postDescription])).toEqual([[C, "V1C", true, null], [A, "Wide", false, "The wide one."], [B, "V1B", false, "Three tumbles for a rainy day."]]);
    const reply = await lastReply();
    expect(reply.steps).toEqual(["Updating a Finals piece"]);
    expect(reply.work).toEqual([{ id: `finals:${TUMBLES}`, kind: "link", title: "Tiny tumbles, spring", href: `/finals/${TUMBLES}`, status: "done", detail: "Renamed, order changed, version named, post description saved, winner set" }]);
  });

  it("as an AI key: a whole order, the winner cleared, a version's name and post description removed; asking for what is there already changes nothing", async () => {
    const out = (await tool(anaKey, "finals_piece_update", { piece: TUMBLES, order: [A, B, C], winner: "none", version: A, version_name: "", post_description: "" })).value;
    expect(out.versions).toEqual([{ id: A }, { id: B, name: "V1B" }, { id: C, name: "V1C" }]);
    expect(out.changed).toEqual(["order changed", "version's name removed", "post description removed", "winner cleared"]);
    expect((await onPage(TUMBLES)).items.map((i) => [i.id, i.label, i.winner, i.postDescription])).toEqual([[A, null, false, null], [B, "V1B", false, "Three tumbles for a rainy day."], [C, "V1C", false, null]]);

    const same = (await tool(anaKey, "finals_piece_update", { piece: TUMBLES, name: "Tiny tumbles, spring", order: [A, B, C], winner: "none", version: A, version_name: "", post_description: " " })).value;
    expect(same).toMatchObject({ changed: [], note: "Nothing changed: the piece was like this already." });
  });

  it("says so when a post description was longer than the longest one kept", async () => {
    const out = (await tool(anaKey, "finals_piece_update", { piece: TUMBLES, version: C, post_description: "tumble ".repeat(400) })).value;
    expect(out.changed).toEqual(["post description saved"]);
    expect(out.note).toBe("The post description was cut to its first 2,200 characters: that is the longest one kept.");
    expect((await onPage(TUMBLES)).items.find((i) => i.id === C)!.postDescription).toHaveLength(2200);
  });

  it("refuses in plain words, and changes nothing, when nothing is given or a version is not this piece's", async () => {
    const before = JSON.stringify(await onPage(TUMBLES));
    const other = (await onPage(BEACH)).items[0]!.id;
    for (const [args, words] of [
      [{ piece: TUMBLES }, "Nothing to change: give a name, a winner, an order, or a version with its version_name or post_description."],
      [{ piece: TUMBLES, version: A }, "Nothing to change: give a name, a winner, an order, or a version with its version_name or post_description."],
      [{ name: "No piece" }, "Give piece: the piece's id (finals_pieces lists them)."],
      [{ piece: TUMBLES, version_name: "Wide" }, "Give version: the id of the version whose name or post description this is."],
      [{ piece: TUMBLES, name: "  " }, "A piece needs a name."],
      [{ piece: TUMBLES, order: A }, "order is a list of version ids."],
      [{ piece: TUMBLES, order: [B, B] }, "order names a version twice."],
      // a refusal comes before the first write: the name given with it is not saved either
      [{ piece: TUMBLES, name: "Half done", winner: other }, `This piece has no version ${other}: finals_pieces with piece lists its versions.`],
      [{ piece: TUMBLES, name: "Half done", order: [B, "fin-1-v1"] }, "This piece has no version fin-1-v1: finals_pieces with piece lists its versions."],
      [{ piece: "pce_nothere", name: "Gone" }, "Not found, or not this account's."],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(await tool(anaKey, "finals_piece_update", args)).toMatchObject({ error: true, text: words });
    }
    expect(JSON.stringify(await onPage(TUMBLES))).toBe(before);
  });
});

describe("finals_piece_trash", () => {
  it("in the dock the question waits on a card: nothing goes to the trash until Yes", async () => {
    const t = await turn("Bin the old warm-up");
    const asked = await tool(t.token, "finals_piece_trash", { piece: BIN });
    expect(asked).toMatchObject({ error: false });
    expect(asked.text).toContain('Asked the user: "Move the piece "Old warm-up" to the trash? Its versions stay in the Media Library. The piece is gone for good after 5 days." Nothing has been changed.');
    await t.end();
    expect(await inTrash()).toEqual([]);
    const reply = await lastReply();
    expect(reply.steps).toEqual(["Working in the Finals trash"]);
    const card = reply.confirms![0]!;
    expect([card.question, card.status]).toEqual(['Move the piece "Old warm-up" to the trash? Its versions stay in the Media Library. The piece is gone for good after 5 days.', "waiting"]);

    expect((await app.request(`/api/assistant/confirms/${card.id}`, { method: "POST", ...json({ yes: true }, { cookie: anaCookie }) })).status).toBe(200);
    expect(await inTrash()).toEqual(["Old warm-up"]);
    // the list leaves it out, the trash names it, and its video is still in the library
    expect((await tool(anaKey, "finals_pieces")).value.pieces.map((p: { id: string }) => p.id)).not.toContain(BIN);
    expect((await tool(anaKey, "finals_piece_trash")).value).toEqual({ trash: [{ id: BIN, name: "Old warm-up", versions: 1 }] });
    expect((await tool(anaKey, "finals_pieces", { piece: BIN })).value).toMatchObject({ id: BIN, trashed: true });
    expect((libraryDb().prepare("SELECT trashed_at FROM assets WHERE title = 'Old warm-up V1A'").get() as { trashed_at: number | null }).trashed_at).toBeNull();
  });

  it("brings a piece back, as the assistant, and says so when a piece is in the trash already or was never there", async () => {
    expect(await tool(anaKey, "finals_piece_trash", { piece: BIN })).toMatchObject({ error: true, text: '"Old warm-up" is in the trash already: restore: true brings it back.' });
    expect(await tool(anaKey, "finals_piece_trash", { piece: KEPT, restore: true })).toMatchObject({ error: true, text: '"Tiny Acrobatics trailer" isn\'t in the trash.' });
    const t = await turn("Bring the old warm-up back");
    expect((await tool(t.token, "finals_piece_trash", { piece: BIN, restore: true })).value).toEqual({ id: BIN, name: "Old warm-up", restored: true, link: `http://localhost/finals/${BIN}` });
    await t.end();
    expect(await inTrash()).toEqual([]);
    expect((await lastReply()).confirms).toBeUndefined();
  });

  it("an AI key from outside the app is not asked here: its own app asks its own way", async () => {
    expect((await tool(anaKey, "finals_piece_trash", { piece: BIN })).value).toEqual({ id: BIN, name: "Old warm-up", trashed: true, note: "Its versions stay in the Media Library. restore: true brings the piece back for 5 days, then it is gone for good." });
    expect(await inTrash()).toEqual(["Old warm-up"]);
    expect((await tool(anaKey, "finals_piece_trash", { piece: BIN, restore: true })).value.restored).toBe(true);
  });
});

describe("another account", () => {
  it("cannot read, change, trash or restore someone else's piece: each is answered as not found, and the piece stays as it was", async () => {
    const before = JSON.stringify(await onPage(KEPT));
    const refused = { error: true, text: "Not found, or not this account's." };
    expect((await tool(nicoKey, "finals_pieces")).value).toEqual({ pieces: [] });
    expect(await tool(nicoKey, "finals_pieces", { piece: KEPT })).toMatchObject(refused);
    expect(await tool(nicoKey, "finals_piece_update", { piece: KEPT, name: "Mine now" })).toMatchObject(refused);
    // his own AI key is not asked first, so this would have gone straight through
    expect(await tool(nicoKey, "finals_piece_trash", { piece: KEPT })).toMatchObject(refused);
    expect(await tool(nicoKey, "finals_piece_trash", { piece: KEPT, restore: true })).toMatchObject(refused);
    expect(JSON.stringify(await onPage(KEPT))).toBe(before);
    expect(await inTrash()).toEqual([]);
    expect(await versions(KEPT)).toEqual(["V1A"]);
    // the page's own route says the same to him
    expect((await onPage(KEPT, nicoCookie)).error).toBe("Not found");
  });
});

describe("a piece the page shows as read only", () => {
  it("is read, and says so; changing it or moving it to the trash is refused in plain words", async () => {
    // a version a plug-in's source added and this account's routes may not change: the page locks such a piece
    libraryDb().prepare("INSERT INTO piece_items (id, piece_id, external_ref, label, position) VALUES ('pci_elsewhere', ?, 'ext_elsewhere', 'From elsewhere', 9)").run(KEPT);
    expect((await onPage(KEPT)).writable).toBe(false);
    expect((await tool(anaKey, "finals_pieces", { piece: KEPT })).value).toMatchObject({ id: KEPT, versions: [{ name: "V1A" }], read_only: true });
    const refused = { error: true, text: "This piece holds a version this account may not change, so the piece is read only here." };
    expect(await tool(anaKey, "finals_piece_update", { piece: KEPT, name: "Trailer, new" })).toMatchObject(refused);
    expect(await tool(anaKey, "finals_piece_trash", { piece: KEPT })).toMatchObject(refused);
    expect((await onPage(KEPT)).label).toBe("Tiny Acrobatics trailer");
    expect(await inTrash()).toEqual([]);
  });
});
