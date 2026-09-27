/**
 * In-memory localStorage/sessionStorage shim, injected as the FIRST thing in the
 * document so the page's own scripts see working storage.
 *
 * The interactive iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
 * (intentional — combining them negates the sandbox for LLM-authored HTML). In a
 * null-origin document, touching `window.localStorage` throws a SecurityError;
 * many generated pages read/write storage in their setup code, so that throw
 * crashes the script before anything renders → a blank/black widget. This shim
 * replaces both storages with an in-memory implementation when the real ones are
 * inaccessible, keeping the sandbox intact while letting storage-using pages run.
 */
const STORAGE_SHIM = `<script data-iframe-storage-shim>
(function () {
  function makeStore() {
    var data = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var s = window[name]; if (s) { s.getItem('__probe__'); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch (e) {}
    }
  });
})();
</script>`;

const INTERACTIVE_RUNTIME_BASE = '/api/openmaic/interactive-runtime';
const PYODIDE_RUNTIME_BASE = `${INTERACTIVE_RUNTIME_BASE}/pyodide/`;
const PYODIDE_LOADER_URL = `${PYODIDE_RUNTIME_BASE}pyodide.js`;
const THREE_RUNTIME_BASE = `${INTERACTIVE_RUNTIME_BASE}/three/0.160.0/`;

/**
 * Generated classrooms historically referenced public CDNs directly. The app's
 * CSP deliberately blocks arbitrary third-party scripts, so those pages could
 * stop before their own error UI ran and leave the learner on an eternal
 * "loading Python" message. Keep persisted classroom HTML immutable and route
 * the known executable runtimes through our same-origin, allowlisted service at
 * render time instead.
 */
function rewriteInteractiveRuntimeUrls(html: string): string {
  const rewritten = html
    .replace(
      /(?:https?:)?\/\/(?:unpkg\.com\/three|cdn\.jsdelivr\.net\/npm\/three)(?:@[^/"'\s<>]+)?\/(build\/|examples\/jsm\/|addons\/)/gi,
      (_match, assetPath: string) => `${THREE_RUNTIME_BASE}${assetPath.toLowerCase() === 'addons/' ? 'examples/jsm/' : assetPath}`,
    )
    .replace(
      /https?:\/\/cdn\.jsdelivr\.net\/pyodide\/v[^/"'\s<>]+\/full\//gi,
      PYODIDE_RUNTIME_BASE,
    )
    .replace(
      /https?:\/\/cdn\.jsdelivr\.net\/npm\/pyodide@[^/"'\s<>]+\//gi,
      PYODIDE_RUNTIME_BASE,
    )
    .replace(
      /https?:\/\/unpkg\.com\/pyodide@[^/"'\s<>]+\//gi,
      PYODIDE_RUNTIME_BASE,
    )
    .replace(
      /https?:\/\/pyodide-cdn2\.iodide\.io\/v[^/"'\s<>]+\/full\//gi,
      PYODIDE_RUNTIME_BASE,
    )
    .replace(
      /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/codemirror\/5\.[^/"'\s<>]+\/codemirror\.min\.css/gi,
      `${INTERACTIVE_RUNTIME_BASE}/codemirror/lib/codemirror.css`,
    )
    .replace(
      /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/codemirror\/5\.[^/"'\s<>]+\/codemirror\.min\.js/gi,
      `${INTERACTIVE_RUNTIME_BASE}/codemirror/lib/codemirror.js`,
    )
    .replace(
      /https?:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/codemirror\/5\.[^/"'\s<>]+\//gi,
      `${INTERACTIVE_RUNTIME_BASE}/codemirror/`,
    )
    .replace(
      /(\/api\/openmaic\/interactive-runtime\/codemirror\/[^"'\s<>]+)\.min\.(js|css)/gi,
      '$1.$2',
    )
    .replace(
      /https?:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^/"'\s<>]+\/dist\//gi,
      `${INTERACTIVE_RUNTIME_BASE}/katex/`,
    );

  // Pyodide 0.25 constructs `new URL(indexURL)` without a base, so a root-
  // relative string is invalid inside srcDoc (`window.location` is
  // `about:srcdoc`). Resolve it against the inherited document base first.
  return rewritten.replace(
    /(\bindexURL\s*:\s*)(["'])\/api\/openmaic\/interactive-runtime\/pyodide\/\2/gi,
    (_match, prefix: string) =>
      `${prefix}new URL('${PYODIDE_RUNTIME_BASE}', document.baseURI).href`,
  );
}

function usesPyodide(html: string): boolean {
  return /\bloadPyodide\s*\(/.test(html);
}

/**
 * Compatibility loader for persisted AI-generated Python pages.
 *
 * Some historical pages call `loadPyodide()` without including the loader,
 * put the loader after the call, or mark it async/defer. Define the API before
 * any generated script runs and lazily fetch the allowlisted same-origin copy.
 * A normal blocking Pyodide script may overwrite this function; otherwise the
 * first call loads it. Failed loader requests are cleared so the page's Retry
 * button can make a fresh attempt instead of reusing a permanently rejected
 * promise.
 */
const PYODIDE_LOADER_SHIM = `<script data-iframe-pyodide-loader>
(function () {
  var runtimeBase = new URL('${PYODIDE_RUNTIME_BASE}', document.baseURI).href;
  var loaderUrl = '${PYODIDE_LOADER_URL}';
  if (typeof window.loadPyodide === 'function') return;

  var loaderPromise = null;
  function getLoader() {
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      var timeout = window.setTimeout(function () {
        loaderPromise = null;
        script.remove();
        reject(new Error('Python runtime loader timed out'));
      }, 15000);
      script.src = loaderUrl;
      script.async = true;
      script.onload = function () {
        window.clearTimeout(timeout);
        var loader = window.loadPyodide;
        if (typeof loader !== 'function' || loader === lazyLoadPyodide) {
          loaderPromise = null;
          reject(new Error('Python runtime loader did not expose loadPyodide'));
          return;
        }
        resolve(loader);
      };
      script.onerror = function () {
        window.clearTimeout(timeout);
        loaderPromise = null;
        script.remove();
        reject(new Error('Failed to load the local Python runtime'));
      };
      (document.head || document.documentElement).appendChild(script);
    });
    return loaderPromise;
  }

  function lazyLoadPyodide(options) {
    return getLoader().then(function (loader) {
      var safeOptions = {};
      if (options && typeof options === 'object') {
        Object.keys(options).forEach(function (key) { safeOptions[key] = options[key]; });
      }
      safeOptions.indexURL = runtimeBase;
      return loader(safeOptions);
    });
  }

  Object.defineProperty(window, 'loadPyodide', {
    configurable: true,
    writable: true,
    value: lazyLoadPyodide
  });
})();
</script>`;

/**
 * Runtime-error capture, injected as the VERY FIRST script so it observes errors
 * from the storage shim and every page script that follows. Generated interactive
 * pages frequently die on a runtime error (a `JSON.parse` of malformed config, a
 * reference to a CDN lib that failed to load, …) → the script aborts and the
 * widget renders blank. The sandboxed (null-origin) iframe can't be read by the
 * editor, but it CAN `postMessage` out: this forwards `window.onerror`, unhandled
 * rejections and `console.error` to the parent, which stores them per scene and
 * feeds them to the editor agent — so it can diagnose a blank page instead of
 * guessing. Only touches `window.*` so it stays sandbox-safe and unit-testable.
 *
 * The most important errors (a `JSON.parse` that aborts setup) fire SYNCHRONOUSLY
 * while srcDoc parses — potentially before the parent has subscribed its `message`
 * listener (which it installs from a passive effect after inserting the iframe).
 * To avoid losing exactly the errors this feature exists to surface, every post is
 * also buffered, and the shim re-emits the whole buffer when the parent sends a
 * `{ __maicErrorReplayRequest: true }` message once its listener is ready. The
 * parent dedups, so the live + replayed copies collapse to one.
 */
const ERROR_CAPTURE_SHIM = `<script data-iframe-error-shim>
(function () {
  var buffer = [];
  function emit(errorKind, message) {
    try {
      window.parent.postMessage(
        { __maicInteractive: true, kind: 'runtime-error', errorKind: errorKind, message: message },
        '*'
      );
    } catch (e) {}
  }
  function post(errorKind, message) {
    message = String(message).slice(0, 1200);
    if (buffer.length < 50) buffer.push([errorKind, message]);
    emit(errorKind, message);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.__maicErrorReplayRequest === true) {
      for (var i = 0; i < buffer.length; i++) emit(buffer[i][0], buffer[i][1]);
    }
  });
  window.addEventListener('error', function (e) {
    if (e && e.message) {
      post('error', e.message + (e.filename ? ' (' + e.filename + ':' + (e.lineno || 0) + ')' : ''));
    } else if (e && e.target && (e.target.src || e.target.href)) {
      post('resource', 'Failed to load resource: ' + (e.target.src || e.target.href));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post('unhandledrejection', (r && (r.stack || r.message)) || r || 'unhandled promise rejection');
  });
  try {
    var c = window.console;
    if (c && c.error) {
      var _ce = c.error;
      c.error = function () {
        try { post('console.error', Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(' ')); } catch (e) {}
        return _ce.apply(c, arguments);
      };
    }
  } catch (e) {}
})();
</script>`;

/**
 * Interaction sync bridge — lets the parent (teacher's InteractiveIframeHost)
 * capture user manipulations inside the iframe and replay them on another
 * iframe (student's projected-readonly copy).
 *
 * Broadcast side (runs in the teacher's iframe): listens for `input`, `change`
 * and `click` events on elements that carry a `[data-sync]` attribute (or form
 * controls inside `[data-sync-region]`), collects their state into a plain
 * object keyed by `data-sync` (falling back to `id` or `name`), and posts it
 * to the parent as `{ __maicInteractive: true, kind: 'state-broadcast', state }`.
 * The `data-sync` convention keeps the payload small and lets LLM-generated
 * scenes opt in by annotating the elements worth syncing; unannotated content
 * (decorative buttons, help toggles, …) is ignored.
 *
 * Apply side (runs in the student's iframe): listens for
 * `{ __maicInteractive: true, kind: 'apply-state', state }` and restores each
 * element's value/checked/active-classes accordingly, then dispatches a
 * `sync-apply` CustomEvent so scene scripts that drive rendering from state
 * can react. Messages are deduped by a JSON stamp to avoid loops.
 *
 * The script is sandbox-safe: only touches `window.*` and `document.*`, never
 * the parent DOM.
 */
const INTERACTION_SYNC_SHIM = `<script data-iframe-interaction-sync>
(function () {
  var lastApplied = '';
  function postActivity(kind) {
    try { window.parent.postMessage({ __maicInteractive: true, kind: kind }, '*'); } catch (e) {}
  }
  // Stable API for generated pages. A page must call complete only after the
  // learner has produced the intended evidence, not after an arbitrary click.
  window.__maicActivity = {
    complete: function () { postActivity('activity-complete'); },
    reset: function () { postActivity('activity-reset'); }
  };
  function collectState() {
    var state = {};
    var nodes = document.querySelectorAll('[data-sync], [data-sync-region] [name], [data-sync-region] input, [data-sync-region] select, [data-sync-region] textarea');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var key = el.getAttribute('data-sync') || el.id || el.name;
      if (!key) continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        state[key] = { checked: el.checked, value: el.value };
      } else if (el.tagName === 'SELECT') {
        state[key] = { value: el.value };
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        state[key] = { value: el.value };
      } else {
        // Generic element: record active class state for toggle-style controls
        var cls = el.getAttribute('data-sync-class');
        if (cls) state[key] = { active: el.classList.contains(cls), class: cls };
      }
    }
    return state;
  }
  function broadcast() {
    try {
      var state = collectState();
      window.parent.postMessage({ __maicInteractive: true, kind: 'state-broadcast', state: state }, '*');
    } catch (e) {}
  }
  // Throttle broadcasts to one per animation frame
  var pending = false;
  function scheduleBroadcast() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () { pending = false; broadcast(); });
  }
  document.addEventListener('input', scheduleBroadcast, true);
  document.addEventListener('change', scheduleBroadcast, true);
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (t && t.closest && t.closest('[data-sync],[data-sync-region]')) scheduleBroadcast();
    if (!t || !t.closest) return;
    if (t.closest('[data-activity-reset],button[type="reset"],input[type="reset"],#reset-btn')) {
      setTimeout(function () { window.__maicActivity.reset(); }, 0);
      return;
    }
    if (t.closest('[data-activity-complete],[data-complete],#finish-btn')) {
      setTimeout(function () { window.__maicActivity.complete(); }, 0);
    }
  }, true);
  // Initial broadcast once the DOM is ready so late-loading viewers get current state
  if (document.readyState === 'complete') broadcast();
  else window.addEventListener('load', function () { setTimeout(broadcast, 100); });

  // Apply side: receive state from parent and restore element values
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.__maicInteractive !== true || d.kind !== 'apply-state') return;
    var state = d.state;
    if (!state || typeof state !== 'object') return;
    var stamp = JSON.stringify(state);
    if (stamp === lastApplied) return;
    lastApplied = stamp;
    Object.keys(state).forEach(function (key) {
      var el = document.querySelector('[data-sync="' + key + '"]') ||
               (document.getElementById(key)) ||
               document.querySelector('[name="' + key + '"]');
      if (!el) return;
      var s = state[key];
      if (!s || typeof s !== 'object') return;
      if ('checked' in s && (el.type === 'checkbox' || el.type === 'radio')) {
        el.checked = !!s.checked;
      } else if ('value' in s && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
        el.value = s.value;
      } else if ('active' in s && s.class) {
        if (s.active) el.classList.add(s.class); else el.classList.remove(s.class);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    window.dispatchEvent(new CustomEvent('sync-apply', { detail: state }));
  });
})();
</script>`;

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects a runtime-error capture shim + a storage shim (so sandboxed pages that
 * use localStorage don't crash) plus CSS that ensures proper sizing and scrolling
 * behavior when HTML content is rendered via srcDoc in an iframe. The shims are
 * placed first so they run before the page's own scripts (error capture first, so
 * it also observes the storage shim). An interaction sync shim is also injected
 * so teacher manipulations inside projected interactive scenes can be replayed
 * on student devices.
 */
export function patchHtmlForIframe(html: string): string {
  const runtimePatchedHtml = rewriteInteractiveRuntimeUrls(html);
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }
</style>`;

  const pyodideLoader = usesPyodide(runtimePatchedHtml) ? `\n${PYODIDE_LOADER_SHIM}` : '';
  const injection = '\n' + ERROR_CAPTURE_SHIM + '\n' + STORAGE_SHIM + '\n' + INTERACTION_SYNC_SHIM + pyodideLoader + '\n' + iframeCss;

  // Insert right after <head> or at the start of the document
  const headIdx = runtimePatchedHtml.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return runtimePatchedHtml.substring(0, insertPos) + injection + runtimePatchedHtml.substring(insertPos);
  }

  const headWithAttrs = runtimePatchedHtml.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = runtimePatchedHtml.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return runtimePatchedHtml.substring(0, insertPos) + injection + runtimePatchedHtml.substring(insertPos);
    }
  }

  // Fallback: prepend
  return injection + runtimePatchedHtml;
}
