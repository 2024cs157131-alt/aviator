/**
 * canvas.js — Renderer only. No game logic. No network calls.
 * Exposed as window.Canvas so app.js can call it safely.
 */
window.Canvas = (function() {

  var cv, ctx, wrap, plane, multEl, crashEl, crashV;
  var state = 'idle', startedAt = null, waitUntil = null;
  var points = [], AF = null, CD = null;

  function init() {
    cv      = document.getElementById('game-canvas');
    ctx     = cv ? cv.getContext('2d') : null;
    wrap    = document.getElementById('canvas-wrap');
    plane   = document.getElementById('plane');
    multEl  = document.getElementById('mult-display');
    crashEl = document.getElementById('crash-display');
    crashV  = document.getElementById('crash-value');
    if (!cv || !ctx) return;
    resize();
    window.addEventListener('resize', function() { resize(); if (state !== 'flying') drawBG(); });
    drawBG();
  }

  function resize() {
    if (!cv || !wrap) return;
    cv.width  = wrap.clientWidth  || 700;
    cv.height = wrap.clientHeight || 320;
  }

  function calcMult(ms) { return Math.max(1, Math.exp(0.00006 * ms)); }
  function multToY(m)   { var H=cv.height; return Math.max(8, H*0.93-(Math.log(m)/Math.log(100))*H*0.87); }
  function elToX(sec)   { return Math.min(10+(sec/60)*(cv.width-20), cv.width-10); }

  function drawBG() {
    if (!ctx) return;
    var W=cv.width, H=cv.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle='#070710'; ctx.fillRect(0,0,W,H);
    var ox=W*0.07, oy=H*1.1;
    for (var i=0;i<22;i++) {
      var a=-0.1+(i/21)*0.9;
      ctx.beginPath(); ctx.moveTo(ox,oy);
      ctx.lineTo(ox+Math.cos(a)*W*3, oy-Math.sin(a)*H*3);
      ctx.strokeStyle='rgba(160,15,15,'+(i%2===0?0.025:0.012)+')';
      ctx.lineWidth=20; ctx.stroke();
    }
    var g=ctx.createRadialGradient(W/2,H/2,H*0.05,W/2,H/2,H);
    g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(1,'rgba(0,0,0,0.65)');
    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
  }

  function drawCountdown() {
    if (!ctx) return;
    drawBG();
    if (!waitUntil) return;
    var W=cv.width, H=cv.height;
    var rem=Math.max(0,(waitUntil-Date.now())/1000);
    var frac=rem/8;
    var cx=W/2, cy=H/2, r=Math.min(W,H)*0.14;

    ctx.beginPath(); ctx.arc(cx,cy,r,0,Math.PI*2);
    ctx.strokeStyle='rgba(255,255,255,0.07)'; ctx.lineWidth=7; ctx.stroke();

    if (frac>0) {
      ctx.save(); ctx.beginPath();
      ctx.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+Math.PI*2*frac);
      ctx.strokeStyle=rem<=2?'#ff5533':'#cc0000';
      ctx.lineWidth=7; ctx.lineCap='round';
      ctx.shadowColor='#ff2200'; ctx.shadowBlur=14;
      ctx.stroke(); ctx.restore();
    }

    var isGo=rem<=0;
    ctx.save();
    ctx.font='900 '+Math.round(r*(isGo?0.58:0.82))+'px Orbitron,monospace';
    ctx.fillStyle=isGo?'#00ff88':(rem<=2?'#ff6644':'#fff');
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.shadowColor=isGo?'#00ff88':'transparent'; ctx.shadowBlur=isGo?28:0;
    ctx.fillText(isGo?'GO!':Math.ceil(rem),cx,cy);
    ctx.restore();

    if (!isGo) {
      ctx.save(); ctx.font='11px Orbitron,monospace';
      ctx.fillStyle='rgba(255,255,255,0.25)';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('STARTING IN',cx,cy-r-17); ctx.restore();
    }
  }

  function drawCurve() {
    if (!ctx) return;
    if (points.length<2) { drawBG(); return; }
    drawBG();
    var W=cv.width, H=cv.height;
    var tip=points[points.length-1];

    var fill=ctx.createLinearGradient(0,H*0.2,0,H);
    fill.addColorStop(0,'rgba(180,0,0,0.42)');
    fill.addColorStop(0.55,'rgba(120,0,0,0.18)');
    fill.addColorStop(1,'rgba(50,0,0,0.04)');
    ctx.fillStyle=fill;
    ctx.beginPath(); ctx.moveTo(points[0].x,H); ctx.lineTo(points[0].x,points[0].y);
    for (var i=1;i<points.length;i++) ctx.lineTo(points[i].x,points[i].y);
    ctx.lineTo(tip.x,H); ctx.closePath(); ctx.fill();

    ctx.save();
    ctx.shadowColor='#ff1100'; ctx.shadowBlur=18;
    ctx.strokeStyle='#ff2222'; ctx.lineWidth=3.5;
    ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.beginPath(); ctx.moveTo(points[0].x,points[0].y);
    for (var j=1;j<points.length;j++) ctx.lineTo(points[j].x,points[j].y);
    ctx.stroke(); ctx.restore();

    if (plane) {
      var tail=points[Math.max(0,points.length-6)];
      var ang=Math.atan2(tail.y-tip.y,tip.x-tail.x);
      plane.style.display='block';
      plane.style.left=(tip.x-52)+'px';
      plane.style.top=(tip.y-24)+'px';
      plane.style.transform='rotate('+(-ang*180/Math.PI)+'deg)';
    }
  }

  function stopAll() {
    if (AF) { cancelAnimationFrame(AF); AF=null; }
    if (CD) { cancelAnimationFrame(CD); CD=null; }
  }

  function cdLoop() {
    drawCountdown();
    if (waitUntil&&(waitUntil-Date.now())>-900) CD=requestAnimationFrame(cdLoop);
    else CD=null;
  }

  function flyLoop() {
    if (!startedAt) { AF=null; return; }
    var ms=Date.now()-startedAt;
    var mult=calcMult(ms);
    points.push({x:elToX(ms/1000),y:multToY(mult)});
    if (points.length>900) points.shift();
    drawCurve();

    if (multEl) {
      multEl.textContent=mult.toFixed(2)+'x';
      multEl.className='mult-display'+(mult<2?'':mult<5?' green':mult<10?' gold':' orange');
    }
    AF=requestAnimationFrame(flyLoop);
  }

  function showWaiting(wu) {
    stopAll(); state='waiting'; waitUntil=wu; points=[]; startedAt=null;
    if (plane) plane.style.display='none';
    if (multEl) multEl.classList.add('hidden');
    if (crashEl) crashEl.classList.add('hidden');
    CD=requestAnimationFrame(cdLoop);
  }

  function showFlying(sa) {
    stopAll(); state='flying'; startedAt=sa; points=[];
    var elapsed=Date.now()-sa;
    for (var ms=0;ms<elapsed;ms+=80) {
      points.push({x:elToX(ms/1000),y:multToY(calcMult(ms))});
    }
    if (crashEl) crashEl.classList.add('hidden');
    if (multEl) { multEl.classList.remove('hidden'); multEl.textContent='1.00x'; multEl.className='mult-display'; }
    AF=requestAnimationFrame(flyLoop);
  }

  function showCrash(cp) {
    stopAll(); state='crashed';
    if (plane) plane.style.display='none';
    if (multEl) multEl.classList.add('hidden');
    if (crashV) crashV.textContent=parseFloat(cp).toFixed(2)+'x';
    if (crashEl) crashEl.classList.remove('hidden');
    drawCurve();
    if (wrap) { wrap.classList.add('flash'); setTimeout(function(){wrap.classList.remove('flash');},400); }
  }

  function showIdle() {
    stopAll(); state='idle'; points=[];
    if (plane) plane.style.display='none';
    if (multEl) multEl.classList.add('hidden');
    if (crashEl) crashEl.classList.add('hidden');
    drawBG();
  }

  function getCurrentMult() {
    if (!startedAt||state!=='flying') return null;
    return calcMult(Date.now()-startedAt);
  }

  // Run init when DOM is ready
  if (document.readyState==='loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { showWaiting: showWaiting, showFlying: showFlying,
           showCrash: showCrash, showIdle: showIdle, getCurrentMult: getCurrentMult };

}());