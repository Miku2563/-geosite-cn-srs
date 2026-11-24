// ==UserScript==
// @name         YouTube CDN Auto Switch (metaAi)
// @description  Switch googlevideo node automatically when download speed is slow
// @namespace    http://tampermonkey.net/
// @version      0.2.0
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @match        https://music.youtube.com/*
// @exclude      https://www.youtube.com/live_chat*
// @grant        none
// @run-at       document-start
// @inject-into  page
// @license      MIT
// ==/UserScript==
(function () {
  'use strict';
  const CFG = {
    minBytes: 256 * 1024,   // 小于该大小的响应不参与测速
    slowMbps: 18,           // 低于该速度算慢
    slowCount: 1,           // 连续慢多少次后切换
    cooldownMs: 120,        // 两次切换的最小间隔
    toast: true,            // 是否显示切换提示
    toastMs: 3500,          // 提示显示时长
    debug: true,
  };
  const TAG = '[yt-cdn-switch]';
  const log = (...a) => CFG.debug && console.log(TAG, ...a);
  // ---------- 提示 Toast ----------
  let toastEl = null;
  let toastTimer = 0;
  function ensureToast() {
    if (toastEl) return toastEl;
    toastEl = document.createElement('div');
    toastEl.setAttribute('style', [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:2147483647',
      'max-width:360px',
      'padding:10px 14px',
      'border-radius:8px',
      'background:rgba(30,30,30,.92)',
      'color:#fff',
      'font:13px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
      'box-shadow:0 4px 14px rgba(0,0,0,.4)',
      'pointer-events:none',
      'opacity:0',
      'transform:translateY(-8px)',
      'transition:opacity .25s ease,transform .25s ease',
      'white-space:pre-line',
      'word-break:break-all',
    ].join(';'));
    return toastEl;
  }
  function showToast(msg, type = 'info') {
    if (!CFG.toast) return;
    const render = () => {
      const el = ensureToast();
      // 全屏时只有全屏元素内部的节点可见,所以挂到 fullscreenElement 下
      const parent = document.fullscreenElement || document.documentElement;
      if (!parent) return;
      if (el.parentNode !== parent) parent.appendChild(el);
      el.textContent = msg;   // 不用 innerHTML,避免 Trusted Types 报错
      el.style.borderLeft = '4px solid ' + (type === 'warn' ? '#f5a623' : '#3ea6ff');
      // 触发过渡动画
      void el.offsetWidth;
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-8px)';
      }, CFG.toastMs);
    };
    if (document.documentElement) render();
    else document.addEventListener('DOMContentLoaded', render, { once: true });
  }
  const shortNode = n => n.replace(/^sn-/, '');
  const stats = new Map();   // node -> { ewma, n }
  const bad = new Set();     // 失败过的节点
  let forced = null;         // 当前强制使用的节点
  let active = null;         // 最近一次实际使用的节点
  let slowStreak = 0;
  let lastSwitch = 0;
  let lastNodes = [];        // 最近一个 URL 的候选节点
  // ---------- URL 解析 ----------
  function inspect(urlStr) {
    let u;
    try { u = new URL(urlStr, location.href); } catch { return null; }
    if (!u.hostname.endsWith('.googlevideo.com') || u.pathname !== '/videoplayback') return null;
    const m = u.hostname.match(/^(r+\d+)---(sn-[a-z0-9-]+)\.googlevideo\.com$/i);
    if (!m) return null;   // redirector.googlevideo.com 等不处理
    const mn = (u.searchParams.get('mn') || '').split(',').filter(Boolean);
    const nodes = [...new Set([m[2], ...mn])];
    return { u, prefix: m[1], node: m[2], nodes };
  }
  // ---------- 选择下一个节点 ----------
  function pickNext(current, nodes) {
    const cands = nodes.filter(n => !bad.has(n));
    const untested = cands.find(n => n !== current && !stats.has(n));
    if (untested) return untested;
    let best = null, bestSpeed = stats.get(current)?.ewma ?? 0;
    for (const n of cands) {
      const s = stats.get(n)?.ewma;
      if (n !== current && s > bestSpeed) { best = n; bestSpeed = s; }
    }
    return best;
  }
  // ---------- 测速结果处理 ----------
  function onSample(node, mbps) {
    const s = stats.get(node) || { ewma: mbps, n: 0 };
    s.ewma = s.n ? s.ewma * 0.6 + mbps * 0.4 : mbps;
    s.n++;
    stats.set(node, s);
    log(node, mbps.toFixed(2) + ' Mbps', '(avg ' + s.ewma.toFixed(2) + ')');
    if (node !== active) return;   // 忽略切换前遗留请求的结果
    slowStreak = mbps < CFG.slowMbps ? slowStreak + 1 : 0;
    if (slowStreak >= CFG.slowCount && Date.now() - lastSwitch > CFG.cooldownMs) {
      const next = pickNext(node, lastNodes);
      slowStreak = 0;
      if (next) {
        forced = next;
        lastSwitch = Date.now();
        log('slow on', node, '→ switch to', next);
        showToast(
          `CDN 已切换\n${shortNode(node)} → ${shortNode(next)}\n(原节点速度 ${mbps.toFixed(1)} Mbps)`
        );
      }
    }
  }
  // ---------- 测速: TransformStream 透传计数, O(1)内存 ----------
  function measure(resp, t0, node) {
    if (!resp.body) return resp;
    try {
      let bytes = 0;
      let lastT = t0;
      const ts = new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength >>> 0;
          lastT = performance.now();
          controller.enqueue(chunk);
        },
        flush() {
          if (bytes < CFG.minBytes) return;
          const sec = (lastT - t0) / 1000;
          if (sec > 0) onSample(node, (bytes * 8) / sec / 1e6);
        }
      });
      const newBody = resp.body.pipeThrough(ts);
      return new Response(newBody, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers
      });
    } catch { return resp; }
  }
  // ---------- 构造改写后的请求参数 ----------
  async function rebuild(input, init, newUrl) {
    if (!(input instanceof Request)) return [newUrl, init];
    const method = input.method;
    const body = (method === 'GET' || method === 'HEAD') ? undefined : await input.clone().arrayBuffer();
    const req = new Request(newUrl, {
      method, headers: input.headers, body,
      mode: input.mode, credentials: input.credentials, cache: input.cache,
      redirect: input.redirect, referrer: input.referrer, signal: input.signal,
      ...init,
    });
    return [req];
  }
  // ---------- Hook fetch ----------
  const origFetch = window.fetch;
  window.fetch = new Proxy(origFetch, {
    async apply(target, thisArg, args) {
      const input = args[0];
      const urlStr = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : input && input.url;
      const info = urlStr && inspect(urlStr);
      if (!info) return Reflect.apply(target, thisArg, args);
      lastNodes = info.nodes;
      let callArgs = args;
      let node = info.node;
      let rewritten = false;
      if (forced && forced !== info.node && info.nodes.includes(forced) && !bad.has(forced)) {
        try {
          info.u.hostname = `${info.prefix}---${forced}.googlevideo.com`;
          callArgs = await rebuild(input, args[1], info.u.href);
          node = forced;
          rewritten = true;
        } catch (e) {
          callArgs = args;
        }
      }
      active = node;
      const t0 = performance.now();
      try {
        const resp = await Reflect.apply(target, thisArg, callArgs);
        if (rewritten && resp.status >= 400) throw new Error('HTTP ' + resp.status);
        if (resp.ok) return measure(resp, t0, node);
        return resp;
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        if (rewritten) {
          log('node failed:', node, String(e), '→ fallback to', info.node);
          showToast(
            `CDN 节点 ${shortNode(node)} 不可用\n已回退到 ${shortNode(info.node)}`,
            'warn'
          );
          bad.add(node);
          forced = null;
          active = info.node;
          return Reflect.apply(target, thisArg, args);
        }
        throw e;
      }
    },
  });
  // 调试:控制台输入 ytCdnStats() 查看各节点速度
  window.ytCdnStats = () => ({
    forced, active,
    bad: [...bad],
    stats: Object.fromEntries(stats),
  });
  log('installed');
})();
