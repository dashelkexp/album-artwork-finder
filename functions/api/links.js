export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const artist = (url.searchParams.get('artist') || '').trim();
  const album = (url.searchParams.get('album') || '').trim();
  let seedUrl = (url.searchParams.get('seed') || '').trim();
  let appleMusicUrl = (url.searchParams.get('apple') || '').trim() || null;
  let bandcampUrl = (url.searchParams.get('bandcampUrl') || '').trim() || null;
  const checkBandcamp = url.searchParams.get('bandcamp') !== 'false';
  const checkPlatforms = url.searchParams.get('platforms') !== 'false';

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) return cachedRes;

  const links = {
    appleMusic: appleMusicUrl,
    spotify: null,
    tidal: null,
    bandcamp: bandcampUrl
  };

  // 1. Ensure we have an Apple Music / seed URL if matched via Deezer, MusicBrainz, or Bandcamp
  if (!links.appleMusic || !seedUrl) {
    const itSeed = await findItunesSeed(artist, album);
    if (itSeed) {
      if (!links.appleMusic) links.appleMusic = itSeed;
      if (!seedUrl) seedUrl = itSeed;
    }
  }

  // 2. Query Odesli (Songlink) for Spotify, Tidal, and Apple Music
  if (checkPlatforms && seedUrl) {
    try {
      const cleanSeed = seedUrl.split('?')[0];
      const odesliRes = await fetch(`https://api.song.link/v1-alpha.1/links?url=${encodeURIComponent(cleanSeed)}&userCountry=US`);
      if (odesliRes.ok) {
        const data = await odesliRes.json();
        const byPlat = data.linksByPlatform || {};
        if (byPlat.appleMusic && byPlat.appleMusic.url) links.appleMusic = byPlat.appleMusic.url;
        if (byPlat.spotify && byPlat.spotify.url) links.spotify = byPlat.spotify.url;
        if (byPlat.tidal && byPlat.tidal.url) links.tidal = byPlat.tidal.url;
      }
    } catch (e) {}
  }

  // 3. Query MusicBrainz URL relations for Bandcamp, Spotify, or Tidal if still missing
  if ((checkPlatforms && (!links.spotify || !links.tidal)) || (checkBandcamp && !links.bandcamp)) {
    const mbLinks = await fetchMusicBrainzRelations(artist, album);
    if (!links.appleMusic && mbLinks.appleMusic) links.appleMusic = mbLinks.appleMusic;
    if (!links.spotify && mbLinks.spotify) links.spotify = mbLinks.spotify;
    if (!links.tidal && mbLinks.tidal) links.tidal = mbLinks.tidal;
    if (!links.bandcamp && mbLinks.bandcamp) links.bandcamp = mbLinks.bandcamp;
  }

  // 4. Direct Bandcamp search fallback
  if (checkBandcamp && !links.bandcamp) {
    links.bandcamp = await searchBandcampPage(artist, album);
  }

  const hasAnyExtraLink = Boolean(links.spotify || links.tidal || links.bandcamp);
  const response = new Response(JSON.stringify(links), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': hasAnyExtraLink ? 'public, max-age=86400' : 'public, max-age=300'
    }
  });

  context.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function cleanString(str, stripLeadingThe = false) {
  let s = (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/\./g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripLeadingThe && s.startsWith('the ')) s = s.substring(4).trim();
  return s;
}

function hasWordOverlap(targetClean, candidateClean) {
  if (!targetClean || !candidateClean) return false;
  if (candidateClean.includes(targetClean) || targetClean.includes(candidateClean)) return true;
  const stopWords = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'with']);
  const targetWords = targetClean.split(' ').filter(w => w.length > 1 && !stopWords.has(w));
  const candList = candidateClean.split(' ');
  if (targetWords.length === 0) return targetClean.split(' ').some(w => candList.includes(w));
  return targetWords.some(w => candList.includes(w));
}

async function findItunesSeed(artist, album) {
  try {
    const q = `${artist} ${album}`.replace(/[^a-zA-Z0-9\u00C0-\u017F\s&-]/g, ' ').trim();
    const res = await fetch(`https://itunes.apple.com/search?media=music&entity=album&limit=10&term=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    for (const item of (data.results || [])) {
      const iArt = cleanString(item.artistName, true);
      const iAlb = cleanString(item.collectionName, false);
      if ((iArt.includes(cleanArt) || cleanArt.includes(iArt)) && hasWordOverlap(cleanAlb, iAlb)) {
        return item.collectionViewUrl ? item.collectionViewUrl.split('?')[0] : null;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchMusicBrainzRelations(artist, album) {
  const found = { appleMusic: null, spotify: null, tidal: null, bandcamp: null };
  try {
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    const q = `artist:"${artist}" AND releasegroup:"${album}"`;
    const headers = { 'Accept': 'application/json', 'User-Agent': 'AlbumArtworkFinder/2.1' };
    const res = await fetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=3`, { headers });
    if (!res.ok) return found;
    const data = await res.json();
    for (const rg of (data['release-groups'] || [])) {
      const rgArt = cleanString((rg['artist-credit'] && rg['artist-credit'][0]) ? rg['artist-credit'][0].name : '', true);
      const rgAlb = cleanString(rg.title || '', false);
      if ((rgArt.includes(cleanArt) || cleanArt.includes(rgArt)) && hasWordOverlap(cleanAlb, rgAlb)) {
        const dRes = await fetch(`https://musicbrainz.org/ws/2/release-group/${rg.id}?inc=url-rels&fmt=json`, { headers });
        if (!dRes.ok) break;
        const dData = await dRes.json();
        for (const rel of (dData.relations || [])) {
          const u = (rel.url && rel.url.resource) ? rel.url.resource : '';
          if (u.includes('bandcamp.com') && !found.bandcamp) found.bandcamp = u;
          if (u.includes('open.spotify.com') && !found.spotify) found.spotify = u;
          if (u.includes('tidal.com') && !found.tidal) found.tidal = u;
          if (u.includes('music.apple.com') && !found.appleMusic) found.appleMusic = u;
        }
        break;
      }
    }
  } catch (e) {}
  return found;
}

async function searchBandcampPage(artist, album) {
  try {
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    const res = await fetch(`https://bandcamp.com/search?q=${encodeURIComponent(`${artist} ${album}`)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const blocks = html.split('<li class="searchresult');
    for (let i = 1; i < blocks.length; i++) {
      const b = blocks[i];
      const heading = b.match(/<div class="heading">\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const subhead = b.match(/<div class="subhead">\s*by\s+([\s\S]*?)<\/div>/i);
      if (!heading || !subhead) continue;
      const pageUrl = heading[1].split('?')[0].trim();
      const titleText = heading[2].replace(/<[^>]+>/g, '').trim();
      const subText = subhead[1].replace(/<[^>]+>/g, '').trim();
      const sArt = cleanString(subText, true);
      if ((sArt.includes(cleanArt) || cleanArt.includes(sArt)) && hasWordOverlap(cleanAlb, cleanString(titleText, false))) {
        return pageUrl;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}
