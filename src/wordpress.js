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

  async function setImageMeta(id, altText) {
    if (!altText) return;
    await wpFetch(`/media/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alt_text: altText, title: altText }),
    }).catch(() => {});
  }

  // El User-Agent de navegador (más abajo) no bastó: el WAF del hosting
  // (edge en openresty — probablemente Imunify360, visto en la cuenta)
  // sigue devolviendo 415 en subidas multipart/form-data, aun con 2
  // reintentos. El patrón multipart en sí parece disparar la regla, no el
  // fingerprint del cliente. La API REST de WP también acepta el archivo
  // como body binario crudo + Content-Disposition (sin boundary multipart),
  // que no la dispara — se intenta primero esa vía; alt_text/title van en
  // un PATCH aparte porque el body binario no deja mandar campos extra.
  // Multipart queda de respaldo por si el binario fallara por otra razón.
  async function uploadImage(buffer, filename, mimeType = 'image/jpeg', altText = '') {
    const attempts = [
      () => wpFetch('/media', {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
        },
        body: buffer,
      }),
      () => {
        const form = new FormData();
        form.append('file', new Blob([buffer], { type: mimeType }), filename);
        if (altText) {
          form.append('alt_text', altText);
          form.append('title', altText);
        }
        return wpFetch('/media', { method: 'POST', body: form });
      },
    ];

    let lastErr;
    for (const upload of attempts) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const data = await upload();
          await setImageMeta(data.id, altText);
          return { id: data.id, url: data.source_url };
        } catch (err) {
          lastErr = err;
          if (!/WordPress API error (415|403)/.test(err.message)) throw err;
          await new Promise(r => setTimeout(r, 2000));
        }
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

  // Espaciado entre publicaciones: si el bot procesa varias noticias seguidas,
  // no queremos que todas salgan con el mismo timestamp (se ve mal en el home
  // y no aporta a la señal de "contenido fresco" para SEO). nextSlot vive en
  // el closure del cliente: se resetea con cada reinicio del proceso, lo cual
  // es aceptable — solo espacia publicaciones dentro de la misma sesión.
  const spacingMs = (site.publishSpacingMinutes ?? 0) * 60_000;
  const MIN_DELAY_MS = 60_000; // por debajo de esto, publicar de una vez
  let nextSlot = 0;

  async function createPost({ title, html, excerpt, slug, focus_keyword, meta_description, mediaId, deporteId, categoryId, tagIds }) {
    const safeTitle = capTitle(title);

    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    const shouldSchedule = spacingMs > 0 && slot - now > MIN_DELAY_MS;
    nextSlot = slot + spacingMs;

    const payload = {
      title: safeTitle,
      content: html,
      excerpt,
      slug,
      featured_media: mediaId,
      ...(deporteId ? { deporte: [deporteId] } : {}),
      ...(categoryId ? { categories: [categoryId] } : {}),
      ...(tagIds?.length ? { tags: tagIds } : {}),
      ...(shouldSchedule ? { date_gmt: new Date(slot).toISOString() } : {}),
      meta: buildSeoMeta({ safeTitle, focus_keyword, meta_description }),
    };

    const post = status =>
      wpFetch('/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, status }),
      });

    try {
      const data = await post(shouldSchedule ? 'future' : 'publish');
      return {
        id: data.id,
        url: data.link,
        status: shouldSchedule ? 'future' : 'publish',
        scheduledFor: shouldSchedule ? new Date(slot) : null,
      };
    } catch (err) {
      if (!/WordPress API error 40[13]/.test(err.message)) throw err;

      // El usuario no tiene permiso de publicar; intenta guardar como borrador
      // para no perder la redacción.
      try {
        const data = await post('draft');
        return { id: data.id, url: data.link, status: 'draft', scheduledFor: null };
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
