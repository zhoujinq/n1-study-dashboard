/* GitHub Pages 静态预览适配层：仅本日进度写入当前浏览器，其余练习保持只读预览。 */
(() => {
  const nativeFetch = window.fetch.bind(window);
  const STORAGE_KEY = 'n1-github-progress-v1';
  const data = window.N1_STATIC_DATA;
  const clone = value => JSON.parse(JSON.stringify(value));
  const json = (value, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });

  function readOverrides() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  window.applyOnlineProgress = function applyOnlineProgress(original) {
    const merged = clone(original);
    merged.days = Object.assign({}, merged.days || {}, readOverrides());
    return merged;
  };

  window.fetch = async function staticFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
      return nativeFetch(input, init);
    }

    const path = url.pathname;
    const method = String(init.method || 'GET').toUpperCase();
    const previewOnly = () => json({
      error: '在线预览版不保存此练习，请在本地看板完成；本日进度可保存在当前浏览器。'
    }, 503);

    if (path === '/api/progress' && method === 'POST') {
      try {
        const payload = JSON.parse(init.body || '{}');
        if (!payload || typeof payload.date !== 'string' || !payload.entry || typeof payload.entry !== 'object') {
          return json({ error: '进度格式无效' }, 400);
        }
        const overrides = readOverrides();
        overrides[payload.date] = payload.entry;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
        return json({ saved: true });
      } catch {
        return json({ error: '当前浏览器无法保存，请使用“导出进度”备份。' }, 503);
      }
    }

    if (path === '/api/vocab/state' && method === 'GET') return json(clone(data.vocab));
    if (path === '/api/vocab/next' && method === 'POST') return json(clone(data.vocab));
    if (path === '/api/vocab/history' && method === 'GET') return json(clone(data.history));
    if (path === '/api/vocab/export' && method === 'GET') {
      return json({ preview: true, state: data.vocab, history: data.history });
    }
    if (path === '/api/papers/catalog' && method === 'GET') return json(clone(data.paperCatalog));
    if (path === '/api/papers/state' && method === 'GET') {
      const requested = url.searchParams.get('set');
      if (requested === data.paper.paper.id) return json(clone(data.paper));
      return json({ error: '此考期仅在本地看板提供；在线预览保留当前考期首屏题目。' }, 503);
    }
    if (path === '/api/papers/notebook' && method === 'GET') {
      return json({ entries: [], reasons: data.paper.reasons || [] });
    }
    return previewOnly();
  };
})();
