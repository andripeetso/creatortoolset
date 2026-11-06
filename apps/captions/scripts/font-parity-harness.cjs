const { chromium } = require('playwright-core');
const fs = require('fs');
const PID = '65105d91-cebc-4afc-a48f-95d827b7a104';
const T = Number(process.env.T || 0.5);
const FORCE = process.env.FORCE_STYLE ? JSON.parse(process.env.FORCE_STYLE) : {};
const OUT = process.env.OUT || '/tmp/cmp';

(async () => {
  const b = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 1300 }, deviceScaleFactor: 2 });
  p.on('console', m => { if (m.type() === 'error') console.error('PAGE', m.text().slice(0, 300)); });
  await p.goto('http://localhost:3100/captions', { waitUntil: 'load' });
  await p.waitForFunction(() => !!window.__studio, null, { timeout: 30000 });

  await p.evaluate(async ({ id, t, force }) => {
    const d = await fetch('/api/projects/' + id).then(r => r.json());
    window.__studio.setState({
      videoUrl: '/api/projects/' + id + '/video', fileName: d.name,
      words: d.words || [], cues: d.cues || [],
      style: { ...d.style, fitBox: true, ...force },
      posSegments: d.posSegments || [], texts: d.texts || [],
      duration: d.duration || 0, currentTime: t,
      sourceWidth: d.srcWidth || 0, sourceHeight: d.srcHeight || 0,
      status: { phase: 'done' }, setupPending: false,
    });
  }, { id: PID, t: T, force: FORCE });

  await p.waitForTimeout(1500);
  await p.evaluate(() => document.fonts.ready);
  // the <video> drives currentTime once it loads — pin it back to T
  await p.evaluate((t) => {
    const v = document.querySelector('video');
    if (v) { v.pause(); try { v.currentTime = t; } catch {} }
    window.__studio.setState({ currentTime: t, playing: false });
  }, T);
  await p.waitForTimeout(700);
  await p.evaluate((t) => window.__studio.setState({ currentTime: t }), T);
  await p.waitForTimeout(300);

  const res = await p.evaluate(async (t) => {
    const st = window.__studio.getState();
    const v = document.querySelector('video');
    const vr = v.getBoundingClientRect();
    const fam = st.style.fontFamily;
    let block = null;
    for (const d of v.parentElement.querySelectorAll('div')) {
      const cs = getComputedStyle(d);
      if (cs.fontFamily.split(',')[0].replace(/"/g, '').trim() === fam &&
          d.className.includes('text-center')) { block = d; break; }
    }
    const mod = await import('/src/lib/ass.ts');
    const ass = mod.buildAss(st.cues, st.style, 1080, 1920, st.posSegments, st.texts);
    if (!block) return { error: 'no block', ass };
    const cs = getComputedStyle(block);
    const br = block.getBoundingClientRect();
    const lines = [...block.children].filter(c => c.tagName === 'DIV')
      .map(d => { const r = d.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    // frame-space scale: the preview is laid out against the displayed height
    const k = 1920 / vr.height;
    return {
      ass, style: st.style, text: block.textContent.trim(),
      videoRect: { w: vr.width, h: vr.height }, k,
      css: { fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight,
             letterSpacing: cs.letterSpacing, padTop: parseFloat(cs.paddingTop),
             padRight: parseFloat(cs.paddingRight), radius: parseFloat(cs.borderTopLeftRadius),
             bg: cs.backgroundColor, weight: cs.fontWeight },
      frame: {
        fontPx: parseFloat(cs.fontSize) * k,
        blockW: br.width * k, blockH: br.height * k,
        cx: (br.x + br.width / 2 - vr.x) * k, cy: (br.y + br.height / 2 - vr.y) * k,
        lineW: lines.map(l => l.w * k), lineH: lines.map(l => l.h * k),
      },
    };
  }, T);

  // shoot the caption alone on black, framed exactly like the export
  const clip = await p.evaluate(() => {
    const v = document.querySelector('video');
    v.style.visibility = 'hidden';
    const r = v.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: OUT + '_preview.png', clip });
  if (res.ass) fs.writeFileSync(OUT + '.ass', res.ass);
  delete res.ass;
  fs.writeFileSync(OUT + '.json', JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  await b.close();
})();
