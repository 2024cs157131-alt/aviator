/**
 * CANVAS.JS — Crown Pesa Aviator Renderer
 *
 * ONLY draws. Makes zero network calls. Makes zero game decisions.
 * Receives startedAt from server → animates locally at 60fps.
 * Formula mirrors server exactly: mult = e^(0.00006 * elapsedMs)
 */

const Canvas = (() => {
  const cv     = document.getElementById('game-canvas');
  const ctx    = cv.getContext('2d');
  const wrap   = document.getElementById('canvas-wrap');
  const plane  = document.getElementById('plane');
  const multEl = document.getElementById('mult-display');
  const crashEl= document.getElementById('crash-display');
  const crashV = document.getElementById('crash-value');

  let state     = 'idle';
  let startedAt = null;
  let waitUntil = null;
  let points    = [];
  let AF        = null;
  let CD        = null;

  // ── RESIZE ──────────────────────────────────────────────
  function resize() {
    cv.width  = wrap.clientWidth  || 700;
    cv.height = wrap.clientHeight || 400;
    if (state !== 'flying') drawBG();
  }
  window.addEventListener('resize', resize);
  resize();

  // ── MATH (mirrors server) ───────────────────────────────
  function calcMult(ms) { return Math.max(1, Math.exp(0.00006 * ms)); }
  function multToY(m)   {
    const H = cv.height;
    return Math.max(8, H * 0.93 - (Math.log(m) / Math.log(100)) * H * 0.87);
  }
  function elToX(sec)   { return Math.min(10 + (sec / 60) * (cv.width - 20), cv.width - 10); }

  // ── BACKGROUND ──────────────────────────────────────────
  function drawBG() {
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#070710';
    ctx.fillRect(0, 0, W, H);

    // Sunburst from bottom-left
    const ox = W * 0.06, oy = H * 1.1;
    for (let i = 0; i < 24; i++) {
      const a = -0.08 + (i / 23) * 0.95;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + Math.cos(a) * W * 3, oy - Math.sin(a) * H * 3);
      ctx.strokeStyle = `rgba(160,15,15,${i % 2 === 0 ? 0.025 : 0.012})`;
      ctx.lineWidth   = 22;
      ctx.stroke();
    }

    // Vignette
    const g = ctx.createRadialGradient(W/2, H/2, H*0.05, W/2, H/2, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // ── COUNTDOWN ───────────────────────────────────────────
  function drawCountdown() {
    drawBG();
    const W = cv.width, H = cv.height;
    if (!waitUntil) return;

    const rem  = Math.max(0, (waitUntil - Date.now()) / 1000);
    const frac = rem / 8;
    const cx = W / 2, cy = H / 2;
    const r  = Math.min(W, H) * 0.14;

    // Track ring
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 7; ctx.stroke();

    // Progress
    if (frac > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI/2, -Math.PI/2 + Math.PI*2*frac);
      ctx.strokeStyle = rem <= 2 ? '#ff5533' : '#cc0000';
      ctx.lineWidth   = 7; ctx.lineCap = 'round';
      ctx.shadowColor = '#ff2200'; ctx.shadowBlur = 14;
      ctx.stroke(); ctx.restore();
    }

    // Number
    const isGo = rem <= 0;
    ctx.save();
    ctx.font         = `900 ${Math.round(r * (isGo ? 0.58 : 0.82))}px Orbitron,monospace`;
    ctx.fillStyle    = isGo ? '#00ff88' : (rem <= 2 ? '#ff6644' : '#fff');
    ctx.textAlign    = 'center'; ctx.textBaseline = 'middle';
    ctx.shadowColor  = isGo ? '#00ff88' : 'transparent'; ctx.shadowBlur = isGo ? 28 : 0;
    ctx.fillText(isGo ? 'GO!' : Math.ceil(rem), cx, cy);
    ctx.restore();

    if (!isGo) {
      ctx.save();
      ctx.font = '11px Orbitron,monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('STARTING IN', cx, cy - r - 17);
      ctx.restore();
    }
  }

  // ── CURVE ────────────────────────────────────────────────
  function drawCurve() {
    if (points.length < 2) { drawBG(); return; }
    drawBG();
    const W = cv.width, H = cv.height;
    const tip = points[points.length - 1];

    // Fill under curve
    const fill = ctx.createLinearGradient(0, H * 0.2, 0, H);
    fill.addColorStop(0, 'rgba(180,0,0,0.42)');
    fill.addColorStop(0.55,'rgba(120,0,0,0.18)');
    fill.addColorStop(1, 'rgba(50,0,0,0.04)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(points[0].x, H);
    ctx.lineTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.lineTo(tip.x, H); ctx.closePath(); ctx.fill();

    // Shadow triangle
    const tri = ctx.createLinearGradient(tip.x * 0.4, tip.y, tip.x, H);
    tri.addColorStop(0, 'rgba(45,0,0,0.55)'); tri.addColorStop(1,'rgba(0,0,0,0)');
    ctx.fillStyle = tri;
    ctx.beginPath();
    ctx.moveTo(points[0].x, H); ctx.lineTo(tip.x, tip.y); ctx.lineTo(tip.x, H);
    ctx.closePath(); ctx.fill();

    // Glow curve
    ctx.save();
    ctx.shadowColor = '#ff1100'; ctx.shadowBlur = 18;
    ctx.strokeStyle = '#ff2222'; ctx.lineWidth = 3.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
    ctx.shadowBlur = 4; ctx.strokeStyle = 'rgba(255,120,90,0.5)'; ctx.lineWidth = 1.5;
    ctx.stroke(); ctx.restore();

    // Plane
    const tail = points[Math.max(0, points.length - 6)];
    const ang  = Math.atan2(tail.y - tip.y, tip.x - tail.x);
    plane.style.display   = 'block';
    plane.style.left      = (tip.x - 52) + 'px';
    plane.style.top       = (tip.y - 24) + 'px';
    plane.style.transform = `rotate(${-ang * 180 / Math.PI}deg)`;
  }

  // ── LOOPS ────────────────────────────────────────────────
  function stopAll() {
    cancelAnimationFrame(AF); AF = null;
    cancelAnimationFrame(CD); CD = null;
  }

  function cdLoop() {
    drawCountdown();
    if (waitUntil && (waitUntil - Date.now()) > -900) CD = requestAnimationFrame(cdLoop);
    else CD = null;
  }

  function flyLoop() {
    if (!startedAt) { AF = null; return; }
    const ms   = Date.now() - startedAt;
    const mult = calcMult(ms);
    points.push({ x: elToX(ms/1000), y: multToY(mult) });
    if (points.length > 900) points.shift();
    drawCurve();

    multEl.textContent = mult.toFixed(2) + 'x';
    multEl.className   = 'mult-display' + (mult<2?'':mult<5?' green':mult<10?' gold':' orange');

    AF = requestAnimationFrame(flyLoop);
  }

  // ── PUBLIC API ───────────────────────────────────────────
  function showWaiting(wu) {
    stopAll(); state='waiting'; waitUntil=wu; points=[]; startedAt=null;
    plane.style.display='none';
    multEl.classList.add('hidden'); crashEl.classList.add('hidden');
    CD = requestAnimationFrame(cdLoop);
  }

  function showFlying(sa) {
    stopAll(); state='flying'; startedAt=sa; points=[];
    // Seed existing points to catch up if we joined mid-round
    const elapsed = Date.now() - sa;
    for (let ms = 0; ms < elapsed; ms += 80) {
      points.push({ x: elToX(ms/1000), y: multToY(calcMult(ms)) });
    }
    crashEl.classList.add('hidden');
    multEl.classList.remove('hidden');
    multEl.textContent = '1.00x';
    multEl.className   = 'mult-display';
    AF = requestAnimationFrame(flyLoop);
  }

  function showCrash(cp) {
    stopAll(); state='crashed';
    plane.style.display='none'; multEl.classList.add('hidden');
    crashV.textContent = parseFloat(cp).toFixed(2) + 'x';
    crashEl.classList.remove('hidden');
    drawCurve(); // freeze last frame
    wrap.classList.add('flash');
    setTimeout(() => wrap.classList.remove('flash'), 400);
  }

  function showIdle() {
    stopAll(); state='idle'; points=[];
    plane.style.display='none'; multEl.classList.add('hidden'); crashEl.classList.add('hidden');
    drawBG();
  }

  function getCurrentMult() {
    if (!startedAt || state !== 'flying') return null;
    return calcMult(Date.now() - startedAt);
  }

  drawBG();
  return { showWaiting, showFlying, showCrash, showIdle, getCurrentMult };
})();
