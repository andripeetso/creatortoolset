/**
 * The card an AI app shows in the chat for some tool answers (MCP Apps: a `ui://` page the app runs in a sandboxed
 * frame, api/mcp-cards.ts). One page draws every kind of card from the data the answer carries (`_meta.card`):
 * a script, footage, a Review video with its comments, an AI Editor edit, an account's posts. It talks to the app
 * around it in JSON-RPC over postMessage (ui/initialize, tool-result, size-changed, open-link, message, tools/call),
 * and reads `window.openai` where an app offers only that. A button that needs the app (Resolve, Refresh, a follow-up
 * message) shows only where the app offers it. Plain script, no build: the page must be one self-contained file. Text goes in with
 * textContent only, never as markup. The look follows the app around it (its colours and font), with no logo: the app
 * shows the plug-in's name above the card itself.
 *
 * No backticks and no dollar-brace in here: it is a String.raw template.
 */
export const CARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Creator Toolset</title>
<style>
:root{color-scheme:light dark;--fg:var(--color-text-primary,#0d0d0d);--mute:var(--color-text-secondary,#5d5d5d);--line:var(--color-border-primary,rgba(0,0,0,.12));--soft:var(--color-background-secondary,rgba(0,0,0,.05));--on:#fff;--ok:#1a7f4b;--warn:#b45309;--bad:#b42318}
:root[data-theme=dark]{--fg:var(--color-text-primary,#f3f3f3);--mute:var(--color-text-secondary,#a8a8a8);--line:var(--color-border-primary,rgba(255,255,255,.14));--soft:var(--color-background-secondary,rgba(255,255,255,.07));--on:#111;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--fg:var(--color-text-primary,#f3f3f3);--mute:var(--color-text-secondary,#a8a8a8);--line:var(--color-border-primary,rgba(255,255,255,.14));--soft:var(--color-background-secondary,rgba(255,255,255,.07));--on:#111;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:transparent}
body{font:14px/1.45 var(--font-sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);color:var(--fg);-webkit-font-smoothing:antialiased}
#c{padding:14px 16px 16px}
#c:empty{padding:0}
.h{display:flex;align-items:center;gap:8px;margin:0 0 10px}
.t{font-size:15px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pill{flex:none;font-size:12px;line-height:20px;padding:0 8px;border-radius:999px;background:var(--soft);color:var(--mute)}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
.sub{font-size:12px;color:var(--mute);margin:-6px 0 10px}
.sec{margin-top:14px}.sec:first-child{margin-top:0}
.lab{font-size:12px;color:var(--mute);margin:0 0 4px}
.ln{display:flex;gap:10px;padding:6px 0;border-top:1px solid var(--line)}.ln:first-child{border-top:0}
.n{flex:none;width:18px;text-align:right;color:var(--mute);font-variant-numeric:tabular-nums;font-size:12px;line-height:20px}
.x{white-space:pre-wrap;overflow-wrap:anywhere;min-width:0;flex:1}
.lk{flex:none;font-size:11px;line-height:20px;color:var(--mute)}
.box{background:var(--soft);border-radius:10px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:12px 10px}
.tile{all:unset;display:block;cursor:pointer;min-width:0;border-radius:10px}
.tile:focus-visible,.btn:focus-visible,.more:focus-visible,.mini:focus-visible,button.at:focus-visible{outline:2px solid var(--fg);outline-offset:2px}
.ph{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background:var(--soft);display:grid;place-items:center;color:var(--mute);font-size:12px}
.ph img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.b{position:absolute;font-size:11px;line-height:16px;padding:0 5px;border-radius:5px;background:rgba(0,0,0,.66);color:#fff}
.b.d{right:6px;bottom:6px;font-variant-numeric:tabular-nums}.b.r{left:6px;top:6px}
.nm{margin-top:6px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd{font-size:12px;color:var(--mute);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tc{font-variant-numeric:tabular-nums;color:var(--fg)}
.cm{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.cm:first-child{border-top:0}
.cm.done{opacity:.55}
.at{flex:none;min-width:72px;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;color:var(--mute)}
.who{font-size:12px;color:var(--mute)}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}.row:first-child{border-top:0}
.row .x{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .mini{align-self:center}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--mute)}
.dot.run{background:var(--warn);animation:p 1.2s ease-in-out infinite}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
@keyframes p{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot.run{animation:none}}
.note{color:var(--mute)}
.acts{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.btn{all:unset;cursor:pointer;font-size:13px;font-weight:500;line-height:32px;padding:0 14px;border-radius:999px;border:1px solid var(--line);color:var(--fg)}
.btn.p{background:var(--fg);color:var(--on);border-color:transparent}
.more{all:unset;cursor:pointer;display:inline-block;font-size:13px;color:var(--mute);margin-top:8px;text-decoration:underline;text-underline-offset:2px}
.player{aspect-ratio:16/9;max-width:100%;margin:0 auto 12px;background:#000;border-radius:10px;overflow:hidden}
.player video{width:100%;height:100%;display:block;object-fit:contain;background:#000}
.np{font-size:12px;color:var(--mute);margin:-6px 0 12px}
.pm{position:absolute;left:50%;top:50%;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(0,0,0,.55)}
.pm:after{content:"";position:absolute;left:13px;top:10px;border-style:solid;border-width:7px 0 7px 11px;border-color:transparent transparent transparent #fff}
.fr{display:block;margin-top:6px;max-width:220px;width:100%;border-radius:8px}
.mini{all:unset;cursor:pointer;flex:none;align-self:flex-start;font-size:12px;line-height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--line);color:var(--fg)}
.mini[disabled]{opacity:.6;cursor:default}
button.at{all:unset;cursor:pointer;flex:none;min-width:72px;font-size:12px;line-height:20px;font-variant-numeric:tabular-nums;color:var(--fg);text-decoration:underline;text-underline-offset:2px}
.cap{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
</style>
</head>
<body>
<div id="c"></div>
<script>
(function () {
  var root = document.getElementById("c");
  var html = document.documentElement;
  var pending = {};
  var nextId = 1;
  var host = false;
  var caps = {};
  var timer = null;
  var refreshes = 0;

  /* ---- the app around the card ---- */
  function post(m) { try { window.parent.postMessage(m, "*"); } catch (e) {} }
  function request(method, params) {
    var id = nextId++;
    return new Promise(function (res, rej) {
      pending[id] = { res: res, rej: rej };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
      setTimeout(function () { if (pending[id]) { delete pending[id]; rej(new Error("No answer")); } }, 30000);
    });
  }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function context(c) {
    if (!c) return;
    if (c.theme === "dark" || c.theme === "light") { html.setAttribute("data-theme", c.theme); html.style.colorScheme = c.theme; }
    var vars = c.styles && c.styles.variables;
    if (vars) for (var k in vars) if (typeof vars[k] === "string" && k.indexOf("--") === 0) html.style.setProperty(k, vars[k]);
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent) return;
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method) {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.rej(new Error(m.error.message || "Refused")); else p.res(m.result || {});
      return;
    }
    if (m.method === "ui/notifications/tool-result") show(m.params || {});
    else if (m.method === "ui/notifications/host-context-changed") context(m.params);
    else if ((m.method === "ui/resource-teardown" || m.method === "ping") && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  function size() {
    var h = Math.ceil(html.getBoundingClientRect().height);
    if (host) notify("ui/notifications/size-changed", { height: h });
    var o = window.openai;
    if (o && typeof o.notifyIntrinsicHeight === "function") { try { o.notifyIntrinsicHeight(h); } catch (e) {} }
  }
  function open(url) {
    if (!url) return;
    var o = window.openai;
    if (host) request("ui/open-link", { url: url }).catch(function () { window.open(url, "_blank", "noopener"); });
    else if (o && typeof o.openExternal === "function") o.openExternal({ href: url });
    else window.open(url, "_blank", "noopener");
  }
  function call(name, args) {
    var o = window.openai;
    if (host) return request("tools/call", { name: name, arguments: args || {} });
    if (o && typeof o.callTool === "function") return Promise.resolve(o.callTool(name, args || {})).then(function (r) { r = r || {}; return { _meta: r._meta || r.meta || {}, structuredContent: r.structuredContent, isError: !!r.isError }; });
    return Promise.reject(new Error("No app"));
  }
  /* what the app around the card offers: calling a tool from a button, and sending a message as the user */
  function canCall() { var o = window.openai; return (host && !!caps.serverTools) || !!(o && typeof o.callTool === "function"); }
  function canSay() { var o = window.openai; return host || !!(o && typeof o.sendFollowUpMessage === "function"); }
  function say(text) {
    var o = window.openai;
    if (host) request("ui/message", { role: "user", content: [{ type: "text", text: text }] }).catch(function () {});
    else if (o && typeof o.sendFollowUpMessage === "function") o.sendFollowUpMessage({ prompt: text });
  }

  /* ---- drawing ---- */
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function add(parent) { for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]); return parent; }
  function button(label, cls, fn) { var b = el("button", cls, label); b.type = "button"; b.addEventListener("click", fn); return b; }
  function head(title, pill, tone) { return add(el("div", "h"), el("div", "t", title), pill ? el("span", "pill" + (tone ? " " + tone : ""), pill) : null); }
  function actions(card, extra) {
    var a = el("div", "acts");
    if (card.href) a.appendChild(button(card.open || "Open in Creator Toolset", "btn p", function () { open(card.href); }));
    if (extra) a.appendChild(extra);
    return a.childNodes.length ? a : null;
  }
  function num(n) { n = Number(n); if (!isFinite(n)) return ""; return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K" : String(n); }
  /* a video in the card: the box takes the video's own shape once it is known (an upright video stays narrow) */
  function player(src, poster, tall) {
    var box = el("div", "player");
    box.style.maxHeight = tall + "px";
    var v = el("video");
    v.controls = true;
    v.playsInline = true;
    v.preload = "metadata";
    if (poster) v.poster = poster;
    v.addEventListener("loadedmetadata", function () {
      if (v.videoWidth && v.videoHeight) {
        box.style.aspectRatio = v.videoWidth + " / " + v.videoHeight;
        if (v.videoHeight > v.videoWidth) box.style.maxWidth = Math.round(tall * v.videoWidth / v.videoHeight) + "px";
      }
      size();
    });
    v.addEventListener("error", function () { box.remove(); size(); });
    v.src = src;
    box.appendChild(v);
    box.video = v;
    return box;
  }
  function start(v) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
  function clock(s) { s = Math.max(0, Math.round(Number(s) || 0)); var m = Math.floor(s / 60), r = s % 60; return (m >= 60 ? Math.floor(m / 60) + ":" + (m % 60 < 10 ? "0" : "") + (m % 60) : m) + ":" + (r < 10 ? "0" : "") + r; }
  /* the first rows, and a button that shows the rest in place (a card never scrolls inside itself) */
  function folded(parent, rows, first, noun) {
    rows.forEach(function (r, i) { if (i >= first) r.hidden = true; parent.appendChild(r); });
    if (rows.length <= first) return null;
    var b = button("Show " + (rows.length - first) + " more " + noun, "more", function () { rows.forEach(function (r) { r.hidden = false; if (r.reveal) r.reveal(); }); b.remove(); size(); });
    return b;
  }

  var STATUS = { draft: "Draft", writing: "Writing", production: "In production", editing: "Editing", toPost: "Ready to post", published: "Published", shelved: "Shelved" };
  var KIND = { reel: "Reel", carousel: "Carousel", ad: "Ad", free: "Text", youtube: "YouTube script", newsletter: "Newsletter", thread: "Thread", article: "Article" };

  function script(card) {
    var out = [];
    if (card.title) out.push(head(card.title, STATUS[card.status] || null, card.status === "published" ? "ok" : ""));
    (card.pieces || []).forEach(function (p) {
      var sec = el("div", "sec");
      var kind = KIND[p.kind] || "";
      var named = p.title && p.title !== card.title && String(p.title).toLowerCase() !== kind.toLowerCase() ? p.title : "";
      var label = [kind, named].filter(Boolean).join(" · ");
      if (label) sec.appendChild(el("div", "lab", label));
      var locked = Array.isArray(p.locked) ? p.locked : [];
      var slides = p.kind === "carousel";
      var list = el("div");
      var rows = (p.blocks || []).filter(function (b) { return b && String(b.text || "").trim(); }).map(function (b, i) {
        return add(el("div", "ln"), slides ? el("span", "n", i + 1) : null, el("div", "x", b.text), locked.indexOf(b.id) >= 0 ? el("span", "lk", "Locked") : null);
      });
      var more = folded(list, rows, 12, slides ? "slides" : "lines");
      if (rows.length) add(sec, list, more);
      else sec.appendChild(el("div", "note", "Nothing written yet."));
      if (p.hooks && p.hooks.length) {
        var hooks = el("div");
        p.hooks.forEach(function (hk) { if (hk && hk.text) hooks.appendChild(add(el("div", "ln"), el("div", "x", hk.text))); });
        add(sec, add(el("div", "sec"), el("div", "lab", "Hooks"), hooks));
      }
      if (p.caption) add(sec, add(el("div", "sec"), el("div", "lab", "Post description"), el("div", "box", p.caption)));
      if (p.pinned) add(sec, add(el("div", "sec"), el("div", "lab", "Pinned comment"), el("div", "box", p.pinned)));
      out.push(sec);
    });
    out.push(actions(card, card.title && canSay() ? button("Find footage", "btn", function () { say('Find footage in my Media Library for the script "' + card.title + '".'); }) : null));
    return out;
  }

  var ROLL = { a: "A-roll", b: "B-roll" };
  var FIRST = 8;
  function footage(card) {
    var items = card.items || [];
    var out = [];
    if (!items.length) {
      out.push(el("div", "note", card.empty || "No clips found."));
      out.push(actions(card));
      return out;
    }
    var n = Math.max(card.total || 0, items.length);
    out.push(head(card.q ? "Footage: " + card.q : "Footage", n + (n === 1 ? " clip" : " clips")));
    /* a clip with a playable copy plays here, above the clips; any other opens in the app */
    var stage = el("div");
    out.push(stage);
    function play(f) {
      while (stage.firstChild) stage.removeChild(stage.firstChild);
      var p = player(f.play, f.thumb, 360);
      add(stage, p, el("div", "np", f.title || "Untitled"));
      start(p.video);
      size();
    }
    var grid = el("div", "grid");
    var tiles = items.map(function (f, i) {
      var t = button(undefined, "tile", function () { if (f.play) play(f); else open(f.href || card.href); });
      t.setAttribute("aria-label", f.title || "Clip");
      var ph = el("div", "ph", f.thumb ? "" : (f.type === "audio" ? "Audio" : f.type === "doc" ? "Document" : f.type === "image" ? "Image" : "Video"));
      if (f.thumb) {
        var img = el("img");
        img.alt = "";
        img.addEventListener("error", function () { img.remove(); ph.insertBefore(document.createTextNode("Video"), ph.firstChild); });
        ph.appendChild(img);
        /* a folded clip's picture is asked for only when the clip is shown */
        if (i < FIRST) img.src = f.thumb; else t.reveal = function () { img.src = f.thumb; };
      }
      if (f.play) ph.appendChild(el("span", "pm"));
      if (f.s) ph.appendChild(el("span", "b d", clock(f.s)));
      if (ROLL[f.roll]) ph.appendChild(el("span", "b r", ROLL[f.roll]));
      add(t, ph, el("div", "nm", f.title || "Untitled"));
      if (f.said) add(t, add(el("div", "sd"), el("span", "tc", f.said.at + " "), document.createTextNode(f.said.text)));
      else if (f.about) t.appendChild(el("div", "sd", f.about));
      return t;
    });
    var more = folded(grid, tiles, FIRST, "clips");
    out.push(grid);
    out.push(more);
    out.push(actions(card, canSay() && items.some(function (f) { return f.type === "video"; }) ? button("Start an edit", "btn", function () { say("Start an edit with these clips."); }) : null));
    return out;
  }

  /* the frames a Review answer carries for its comments: a line "Comment <id> (…)" and then the picture */
  function framesOf(result) {
    var out = {};
    var c = (result && result.content) || [];
    for (var i = 0; i + 1 < c.length; i++) {
      var m = c[i] && c[i].type === "text" && /^Comment (\S+) \(/.exec(c[i].text || "");
      var im = c[i + 1];
      if (m && im && im.type === "image" && im.data) out[m[1]] = "data:" + (im.mimeType || "image/jpeg") + ";base64," + im.data;
    }
    return out;
  }
  function review(card, result) {
    var out = [];
    var tone = card.approval === "approved" ? "ok" : card.approval === "changes" || card.approval === "rejected" ? "warn" : "";
    var pill = card.approval === "approved" ? "Approved" : card.approval === "changes" || card.approval === "rejected" ? "Changes asked" : null;
    out.push(head(card.title || "Review", pill, tone));
    var video = null;
    if (card.play) { var p = player(card.play, card.poster, 480); video = p.video; out.push(p); }
    var frames = card.frames ? framesOf(result) : {};
    var comments = card.comments || [];
    var sub = el("div", "sub");
    function count() {
      var open = comments.filter(function (c) { return !c.resolved; }).length;
      sub.textContent = comments.length ? open + " open" + (comments.length > open ? " · " + (comments.length - open) + " resolved" : "") : "No comments yet";
    }
    count();
    out.push(sub);
    var list = el("div");
    var rows = comments.map(function (c) {
      var row = el("div", "cm" + (c.resolved ? " done" : ""));
      /* with the video in the card, a comment's time jumps to it (a comment on the version that is playing) */
      var at = video && typeof c.t === "number" && c.v === card.v ? button(c.at || "", "at", function () { video.currentTime = c.t; start(video); }) : el("span", "at", c.at || "");
      var body = el("div", "x");
      body.appendChild(document.createTextNode(c.text || ""));
      var who = el("div", "who");
      function label() {
        who.textContent = [c.author, c.v > 1 || card.versions > 1 ? "v" + c.v : "", c.replies ? c.replies + (c.replies === 1 ? " reply" : " replies") : "", c.resolved ? "Resolved" : ""].filter(Boolean).join(" · ");
        who.hidden = !who.textContent;
      }
      label();
      body.appendChild(who);
      if (frames[c.id] && !c.resolved) {
        var im = el("img", "fr");
        im.alt = "";
        im.addEventListener("load", size);
        im.src = frames[c.id];
        body.appendChild(im);
      }
      add(row, at, body);
      if (!c.resolved && c.id && card.href && canCall()) {
        var b = button("Resolve", "mini", function () {
          b.disabled = true;
          b.textContent = "Resolving";
          call("resolve_comment", { link: card.href, comment_id: c.id }).then(function (r) {
            if (r && r.isError) throw new Error("Refused");
            c.resolved = true;
            row.className = "cm done";
            b.remove();
            label();
            count();
            size();
          }).catch(function () { b.disabled = false; b.textContent = "Resolve"; });
        });
        row.appendChild(b);
      }
      return row;
    });
    var more = folded(list, rows, 6, "comments");
    out.push(list);
    out.push(more);
    out.push(actions(card));
    return out;
  }

  var DRAFT = { "being made": ["run", "Being made"], "in Review": ["ok", "Ready in Review"], failed: ["bad", "Failed"], none: ["", "Not made yet"] };
  function busy(card) { return !!card.running || (card.drafts || []).some(function (d) { return d.preview === "being made"; }); }
  function edit(card) {
    var out = [];
    var run = busy(card);
    out.push(head(card.title || "Edit", run ? "Working" : card.failed ? "Needs a look" : null, run ? "warn" : card.failed ? "bad" : ""));
    var drafts = card.drafts || [];
    if (drafts.length) {
      var list = el("div");
      drafts.forEach(function (d) {
        var st = DRAFT[d.preview] || DRAFT.none;
        add(list, add(el("div", "row"), el("span", "dot " + st[0]), el("div", "x", d.title || d.name), el("span", "who", st[1]), d.href ? button("Watch", "mini", function () { open(d.href); }) : null));
      });
      out.push(list);
    } else out.push(el("div", "note", run ? "It is going through your footage. The first cut shows here when it is ready." : "No versions yet."));
    out.push(actions(card, card.id && canCall() ? button("Refresh", "btn", function () { refresh(card, true); }) : null));
    if (run && canCall()) wait(card);
    return out;
  }
  /* an edit takes minutes: while it runs, the card asks again by itself (up to 20 minutes, only while it is on screen) */
  function refresh(card, byHand) {
    return call("editor_get", { edit: card.id }).then(function (r) { show(r, true); }).catch(function () { if (!byHand) wait(card); });
  }
  function wait(card) {
    if (timer) clearTimeout(timer);
    if (refreshes >= 40 || !card.id) return;
    timer = setTimeout(function () {
      timer = null;
      if (document.visibilityState === "hidden") return wait(card);
      refreshes++;
      refresh(card, false);
    }, 30000);
  }

  function posts(card) {
    var items = card.items || [];
    var out = [];
    var n = Math.max(card.total || 0, items.length);
    out.push(head(card.title || "Posts", items.length ? n + (n === 1 ? " post" : " posts") : null));
    if (!items.length) {
      out.push(el("div", "note", card.empty || "No posts."));
      out.push(actions(card));
      return out;
    }
    var list = el("div");
    var rows = items.map(function (p) {
      var body = el("div", "x");
      body.appendChild(el("div", "cap", p.text || "No description"));
      var stats = [p.when, p.plays != null ? num(p.plays) + " plays" : "", p.likes != null ? num(p.likes) + " likes" : "", p.comments != null ? num(p.comments) + " comments" : ""].filter(Boolean).join(" · ");
      if (stats) body.appendChild(el("div", "who", stats));
      return add(el("div", "cm"), body, p.href ? button("Open", "mini", function () { open(p.href); }) : null);
    });
    var more = folded(list, rows, 6, "posts");
    out.push(list);
    out.push(more);
    out.push(actions(card));
    return out;
  }

  var DRAW = { script: script, footage: footage, review: review, edit: edit, posts: posts };
  function show(result, again) {
    var meta = (result && result._meta) || {};
    var card = meta.card || (result && result.structuredContent && result.structuredContent.card);
    if (!card || !DRAW[card.kind]) {
      /* the app sent an answer without the card's data: say what arrived, so the cause can be found */
      /* a call that was refused has no card: the frame stays empty and the AI says why */
      if (!again && !root.firstChild && result && !result.isError && (result.content || result.structuredContent || result._meta)) {
        root.appendChild(el("div", "note", "Nothing to show here (" + Object.keys(result).join(", ") + (host ? "; apps" : "") + (window.openai ? "; openai" : "") + ")."));
        size();
      }
      return;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    while (root.firstChild) root.removeChild(root.firstChild);
    DRAW[card.kind](card, result).forEach(function (n) { if (n) root.appendChild(n); });
    size();
  }

  /* ---- start ---- */
  function fromOpenAI() {
    var o = window.openai;
    if (!o) return;
    if (o.theme) context({ theme: o.theme });
    if (o.toolResponseMetadata || o.toolOutput) show({ _meta: o.toolResponseMetadata || {}, structuredContent: o.toolOutput || undefined });
  }
  fromOpenAI();
  window.addEventListener("openai:set_globals", fromOpenAI);
  if (typeof ResizeObserver === "function") new ResizeObserver(size).observe(html);
  if (window.parent && window.parent !== window) {
    request("ui/initialize", { appInfo: { name: "creator-toolset-card", version: "1.0.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
      .then(function (r) { host = true; caps = r.hostCapabilities || {}; context(r.hostContext); notify("ui/notifications/initialized"); size(); })
      .catch(function () {});
  }
})();
</script>
</body>
</html>
`;
