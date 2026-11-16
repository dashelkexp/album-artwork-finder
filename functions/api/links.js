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

  const links = {
    appleMusic: appleMusicUrl ? appleMusicUrl.split('?')[0] : null,
    spotify: null,
    tidal: null,
    bandcamp: bandcampUrl,
    seedUrl: seedUrl ? seedUrl.split('?')[0] : null
  };

  // 1. Ensure Apple Music / Seed URL via iTunes Search (album, then song fallback)
  if (!links.appleMusic || !links.seedUrl) {
    const itunesUrl = await findItunesAlbumUrl(artist, album);
    if (itunesUrl) {
      if (!links.appleMusic) links.appleMusic = itunesUrl;
      if (!links.seedUrl) links.seedUrl = itunesUrl;
    }
  }

  // 2. If still no seedUrl, get Deezer album URL (Deezer never blocks cloud IPs)
  if (!links.seedUrl) {
    const dzUrl = await findDeezerAlbumUrl(artist, album);
    if (dzUrl) links.seedUrl = dzUrl;
  }

  // 3. Query MusicBrainz Release-Group & Release URL Relations for Bandcamp, Spotify, Tidal
  if (checkPlatforms || checkBandcamp) {
    const mbLinks = await fetchMusicBrainzRelations(artist, album);
    if (!links.appleMusic && mbLinks.appleMusic) links.appleMusic = mbLinks.appleMusic;
    if (!links.spotify && mbLinks.spotify) links.spotify = mbLinks.spotify;
    if (!links.tidal && mbLinks.tidal) links.tidal = mbLinks.tidal;
    if (!links.bandcamp && mbLinks.bandcamp) links.bandcamp = mbLinks.bandcamp;
  }

  return new Response(JSON.stringify(links), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
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

async function findItunesAlbumUrl(artist, album) {
  const q = `${artist} ${album}`.replace(/[^a-zA-Z0-9\u00C0-\u017F\s&-]/g, ' ').trim();
  const cleanArt = cleanString(artist, true);
  const cleanAlb = cleanString(album, false);

  for (const entity of ['album', 'song']) {
    try {
      const res = await fetch(`https://itunes.apple.com/search?media=music&entity=${entity}&limit=10&term=${encodeURIComponent(q)}`);
      if (!res.ok) continue;
      const data = await res.json();
      for (const item of (data.results || [])) {
        const iArt = cleanString(item.artistName, true);
        const iAlb = cleanString(item.collectionName, false);
        const iTrk = cleanString(item.trackName, false);
        if ((iArt.includes(cleanArt) || cleanArt.includes(iArt)) &&
            (hasWordOverlap(cleanAlb, iAlb) || hasWordOverlap(cleanAlb, iTrk))) {
          if (item.collectionViewUrl) return item.collectionViewUrl.split('?')[0];
        }
      }
    } catch (e) {}
  }
  return null;
}

async function findDeezerAlbumUrl(artist, album) {
  try {
    const q = `${artist} ${album}`.replace(/[^a-zA-Z0-9\u00C0-\u017F\s&-]/g, ' ').trim();
    const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=5`);
    if (!res.ok) return null;
    const data = await res.json();
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    for (const item of (data.data || [])) {
      const iArt = cleanString(item.artist ? item.artist.name : '', true);
      const iAlb = cleanString(item.title || '', false);
      if ((iArt.includes(cleanArt) || cleanArt.includes(iArt)) && hasWordOverlap(cleanAlb, iAlb)) {
        return item.link || null;
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
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'AlbumArtworkFinder/2.2 (contact@example.com)'
    };

    const res = await fetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=3`, { headers });
    if (!res.ok) return found;
    const data = await res.json();

    for (const rg of (data['release-groups'] || [])) {
      const rgArt = cleanString((rg['artist-credit'] && rg['artist-credit'][0]) ? rg['artist-credit'][0].name : '', true);
      const rgAlb = cleanString(rg.title || '', false);
      if ((rgArt.includes(cleanArt) || cleanArt.includes(rgArt)) && hasWordOverlap(cleanAlb, rgAlb)) {
        const dRes = await fetch(`https://musicbrainz.org/ws/2/release-group/${rg.id}?inc=url-rels+releases&fmt=json`, { headers });
        if (!dRes.ok) break;
        const dData = await dRes.json();

        for (const rel of (dData.relations || [])) {
          const u = (rel.url && rel.url.resource) ? rel.url.resource : '';
          if (u.includes('bandcamp.com') && !found.bandcamp) found.bandcamp = u;
          if (u.includes('open.spotify.com') && !found.spotify) found.spotify = u;
          if (u.includes('tidal.com') && !found.tidal) found.tidal = u;
          if (u.includes('music.apple.com') && !found.appleMusic) found.appleMusic = u;
        }

        // Also check the primary release's URL relations (where streaming links are most often stored)
        if ((!found.spotify || !found.tidal || !found.bandcamp) && dData.releases && dData.releases.length > 0) {
          const relRes = await fetch(`https://musicbrainz.org/ws/2/release/${dData.releases[0].id}?inc=url-rels&fmt=json`, { headers });
          if (relRes.ok) {
            const relData = await relRes.json();
            for (const rel of (relData.relations || [])) {
              const u = (rel.url && rel.url.resource) ? rel.url.resource : '';
              if (u.includes('bandcamp.com') && !found.bandcamp) found.bandcamp = u;
              if (u.includes('open.spotify.com') && !found.spotify) found.spotify = u;
              if (u.includes('tidal.com') && !found.tidal) found.tidal = u;
              if (u.includes('music.apple.com') && !found.appleMusic) found.appleMusic = u;
            }
          }
        }
        break;
      }
    }
  } catch (e) {}
  return found;
}
