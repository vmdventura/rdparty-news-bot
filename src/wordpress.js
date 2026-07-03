const TITLE_MAX = 70; // deportesdo-core rechaza con 422 títulos de más de 70 caracteres

function capTitle(title) {
  if (title.length <= TITLE_MAX) return title;
  return `${title.slice(0, TITLE_MAX - 1).replace(/\s+\S*$/, '')}…`;
}

// Node/undici manda "User-Agent: node" por defecto — un fingerprint que
// varios WAFs de hosting bloquean en endpoints de subida, sobre todo desde
// IPs de datacenter (como las de GitHub Actions). Un UA de navegador real
// evita el bloqueo sin cambiar nada del lado de WordPress.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Cliente WordPress ligado a un sitio (URL + credenciales + plugin SEO).
export function createWpClient(site) {
  const BASE_URL = `${site.wpUrl}/wp-json/wp/v2`;
  const authHeader =
    'Basic ' + Buffer.from(`${site.wpUser}:${site.wpPass}`).toString('base64');

  async function wpFetch(path, options = {}) {
    const res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      headers: {
        Authorization: authHeader,
        'User-Agent': BROWSER_UA,
        Referer: site.wpUrl,
        ...options.headers,
      },
    });

    let body;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      body = await res.json();
    } else {
      body = await res.text();
    }

    if (!res.ok) {
      const message = body?.message || body?.code || JSON.stringify(body).slice(0, 300);
      throw new Error(`WordPress API error ${res.status}: ${message}`);
    }

    return body;
  }

  async function uploadImage(buffer, filename, mimeType = 'image/jpeg', altText = '') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), filename);
    if (altText) {
      form.append('alt_text', altText);
      form.append('title', altText);
    }

    // El endpoint de subida es el más sensible a WAF; reintenta una vez si
    // el edge lo bloquea (415/403) — a veces es un bloqueo por IP transitorio.
    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const data = await wpFetch('/media', { method: 'POST', body: form });
        return { id: data.id, url: data.source_url };
      } catch (err) {
        lastErr = err;
        if (!/WordPress API error (415|403)/.test(err.message)) throw err;
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    throw lastErr;
  }

  // Busca cada etiqueta por nombre; si no existe la crea. Devuelve los term IDs.
  // El rol Editor tiene manage_categories, así que puede crear etiquetas.
  async function ensureTags(names = []) {
    // Claude a veces devuelve las etiquetas como string ("España, Mundial")
    // en vez de array; iterar un string da caracteres sueltos como tags.
    const list = (Array.isArray(names) ? names : String(names).split(','))
      .map(n => String(n).trim())
      .filter(n => n.length > 1)
      .slice(0, 6);

    const ids = [];
    for (const clean of list) {
      try {
        const found = await wpFetch(`/tags?search=${encodeURIComponent(clean)}&per_page=20`);
        const match = found.find(t => t.name.toLowerCase() === clean.toLowerCase());
        if (match) {
          ids.push(match.id);
          continue;
        }
        const created = await wpFetch('/tags', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: clean }),
        });
        ids.push(created.id);
      } catch {
        // Etiqueta conflictiva (slug duplicado, etc.) — el post sale sin ella.
      }
    }
    return ids;
  }

  async function getCurrentUser() {
    return wpFetch('/users/me?context=edit');
  }

  // Mapa slug → { id, name } de la taxonomía 'deporte' (solo DeportesDO).
  // Endpoint público del plugin deportesdo-core.
  async function getTaxonomyMap() {
    const res = await fetch(`${site.wpUrl}/wp-json/deportesdo/v1/taxonomy-map`);
    if (!res.ok) throw new Error(`No se pudo obtener el taxonomy-map (HTTP ${res.status})`);
    const data = await res.json();
    return data.deporte || {};
  }

  // Mapa slug → { id, name } de las categorías nativas del sitio.
  async function getCategories() {
    const cats = await wpFetch('/categories?per_page=100&hide_empty=false');
    const map = {};
    for (const c of cats) {
      if (c.slug === 'uncategorized') continue;
      map[c.slug] = { id: c.id, name: c.name };
    }
    return map;
  }

  async function getCategoryIdBySlug(slug) {
    if (!slug) return null;
    const res = await fetch(`${BASE_URL}/categories?slug=${encodeURIComponent(slug)}`);
    if (!res.ok) return null;
    const cats = await res.json();
    return cats[0]?.id ?? null;
  }

  // Campos meta según el plugin SEO del sitio. Ambos requieren que el
  // WordPress los registre en REST (register_post_meta con show_in_rest).
  function buildSeoMeta({ safeTitle, focus_keyword, meta_description }) {
    if (site.seo === 'yoast') {
      return {
        _yoast_wpseo_focuskw: focus_keyword,
        _yoast_wpseo_metadesc: meta_description,
        _yoast_wpseo_title: `${safeTitle} | ${site.brand}`,
      };
    }
    return {
      rank_math_focus_keyword: focus_keyword,
      rank_math_description: meta_description,
      rank_math_title: `${safeTitle} | ${site.brand}`,
    };
  }

  async function createPost({ title, html, excerpt, slug, focus_keyword, meta_description, mediaId, deporteId, categoryId, tagIds }) {
    const safeTitle = capTitle(title);
    const payload = {
      title: safeTitle,
      content: html,
      excerpt,
      slug,
      featured_media: mediaId,
      ...(deporteId ? { deporte: [deporteId] } : {}),
      ...(categoryId ? { categories: [categoryId] } : {}),
      ...(tagIds?.length ? { tags: tagIds } : {}),
      meta: buildSeoMeta({ safeTitle, focus_keyword, meta_description }),
    };

    const post = status =>
      wpFetch('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, status }),
      });

    try {
      const data = await post('publish');
      return { id: data.id, url: data.link, published: true };
    } catch (err) {
      if (!/WordPress API error 40[13]/.test(err.message)) throw err;

      // El usuario no tiene permiso de publicar; intenta guardar como borrador
      // para no perder la redacción.
      try {
        const data = await post('draft');
        return { id: data.id, url: data.link, published: false };
      } catch {
        const who = await getCurrentUser().catch(() => null);
        const role = who?.roles?.join(', ') || 'desconocido';
        throw new Error(
          `El usuario de WordPress no tiene permiso para crear entradas (rol actual: ${role}). ` +
          `Verifica en wp-admin > Usuarios que el rol sea Editor o superior.`
        );
      }
    }
  }

  return { wpFetch, uploadImage, ensureTags, getCurrentUser, getTaxonomyMap, getCategories, getCategoryIdBySlug, createPost };
}
