export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl || !targetUrl.startsWith('http')) {
    return new Response('Invalid image URL', { status: 400 });
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AlbumArtworkFinder/2.0)'
      }
    });

    if (!res.ok) {
      return new Response('Failed to fetch upstream image', { status: res.status });
    }

    const headers = new Headers();
    headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');

    return new Response(res.body, {
      status: 200,
      headers
    });
  } catch (e) {
    return new Response('Proxy error', { status: 502 });
  }
}
