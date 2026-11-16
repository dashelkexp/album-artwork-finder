export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const artist = (url.searchParams.get('artist') || '').trim();
  const album = (url.searchParams.get('album') || '').trim();
  const checkBandcamp = url.searchParams.get('bandcamp') !== 'false';

  if (!artist && !album) {
    return jsonResponse({ error: 'Missing artist or album parameter' }, 400);
  }

  const cache = caches.default;
  const cacheKey = new Request(url.toString(), request);
  const cachedRes = await cache.match(cacheKey);
  if (cachedRes) return cachedRes;

  const result = await resolveRelease({ artist, album, checkBandcamp });
  const cacheHeader = result.status === 'Found' ? 'public, max-age=86400' : 'no-store';
  const response = jsonResponse(result, 200, { 'Cache-Control': cacheHeader });

  if (result.status === 'Found') {
    context.waitUntil(cache.put(cacheKey, response.clone()));
  }
  return response;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders
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
  if (stripLeadingThe && s.startsWith('the ')) {
    s = s.substring(4).trim();
  }
  return s;
}

function sanitizeQueryForApi(str) {
  return (str || '')
    .replace(/[^a-zA-Z0-9\u00C0-\u017F\s&-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasWordOverlap(targetClean, candidateClean) {
  if (!targetClean || !candidateClean) return false;
  if (candidateClean.includes(targetClean) || targetClean.includes(candidateClean)) return true;
  const stopWords = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'with']);
  const targetWords = targetClean.split(' ').filter(w => w.length > 1 && !stopWords.has(w));
  const candList = candidateClean.split(' ');
  if (targetWords.length === 0) {
    return targetClean.split(' ').some(w => candList.includes(w));
  }
  return targetWords.some(w => candList.includes(w));
}

function evaluateArtistMatch(itemArtistClean, targetArtistClean) {
  if (!itemArtistClean || !targetArtistClean) return -999;
  if (itemArtistClean === targetArtistClean) return 100;
  if (itemArtistClean.includes(targetArtistClean) || targetArtistClean.includes(itemArtistClean)) return 75;

  if (targetArtistClean.includes(' and ') || targetArtistClean.includes('&') || targetArtistClean.includes(',')) {
    const subArtists = targetArtistClean.split(/&|and|,/).map(s => s.trim()).filter(Boolean);
    if (subArtists.some(sa => itemArtistClean.includes(sa) || sa.includes(itemArtistClean))) {
      return 70;
    }
  }
  return -999;
}

function normalizeAppleAlbumUrl(url) {
  return url ? url.split('?')[0] : null;
}

function classifyReleaseType(item, sourceName) {
  const title = (item.collectionName || '').toLowerCase();
  if (sourceName === 'iTunes') {
    const cType = (item.collectionType || '').toLowerCase();
    const tCount = item.trackCount || 0;
    if (title.includes(' - single') || title.includes('(single)') || cType === 'single' || tCount === 1) return 'Single';
    if (title.includes(' - ep') || title.includes('(ep)') || (tCount >= 2 && tCount <= 6)) return 'EP';
    if (title.includes('soundtrack') || title.includes('compilation') || title.includes('greatest hits')) return 'Other';
    if (cType === 'album' || tCount >= 7) return 'Album';
    return 'Other';
  }
  if (sourceName === 'Deezer') {
    const rType = (item.recordType || '').toLowerCase();
    if (rType === 'single') return 'Single';
    if (rType === 'ep') return 'EP';
    if (rType === 'album') return 'Album';
    return 'Other';
  }
  if (sourceName === 'Cover Art Archive') {
    const pType = (item.primaryType || '').toLowerCase();
    if (pType === 'single') return 'Single';
    if (pType === 'ep') return 'EP';
    if (pType === 'album') return 'Album';
    return 'Other';
  }
  if (sourceName === 'Bandcamp') {
    if (item.bcType === 'track') return 'Single';
    if (title.includes(' ep') || title.includes('(ep)')) return 'EP';
    return 'Album';
  }
  return 'Other';
}

function scoreItemMatch(item, targetArtist, targetAlbum, isSongSearch, hasFullAlbumAlternative) {
  const itemArtist = cleanString(item.artistName, true);
  const targetArt = cleanString(targetArtist, true);
  const artistScore = evaluateArtistMatch(itemArtist, targetArt);
  if (artistScore < 0) return -999;

  const targetAlb = cleanString(targetAlbum, false);
  const itemAlbum = cleanString(item.collectionName, false);
  const itemTrack = cleanString(item.trackName, false);

  const isGenericFormatQuery = targetAlb === 'single' || targetAlb === 'ep';
  const comparisonTitle = (isSongSearch && itemTrack) ? itemTrack : itemAlbum;

  if (!isGenericFormatQuery && targetAlb && !hasWordOverlap(targetAlb, comparisonTitle)) {
    return -999;
  }

  let score = artistScore;
  if (isGenericFormatQuery) {
    score += 40;
  } else if (comparisonTitle === targetAlb) {
    score += 100;
  } else if (comparisonTitle.startsWith(targetAlb)) {
    score += 65;
  } else if (comparisonTitle.includes(targetAlb)) {
    score += 45;
  } else {
    score += 15;
  }

  const rawTitle = (item.collectionName || '').toLowerCase();
  const isTargetSingle = targetAlb.includes('single');
  const isSingleRelease = item.trackCount === 1 ||
    (item.collectionType || '').toLowerCase() === 'single' ||
    rawTitle.includes(' - single') ||
    rawTitle.includes('(single)');

  if (!isTargetSingle && hasFullAlbumAlternative && isSingleRelease) {
    score -= 45;
  }

  if (rawTitle.includes('booklet') || rawTitle.includes('pdf')) score -= 250;
  if (rawTitle.includes('tribute') || rawTitle.includes('karaoke')) score -= 160;
  if (rawTitle.includes('instrumental') && !targetAlb.includes('instrumental')) score -= 35;
  if (rawTitle.includes('commentary') && !targetAlb.includes('commentary')) score -= 50;

  return score;
}

async function queryItunes(query, entity = 'album', country = 'us') {
  try {
    const url = `https://itunes.apple.com/search?media=music&entity=${entity}&country=${country}&limit=15&term=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch (e) {
    return [];
  }
}

async function queryDeezer(artist, album) {
  try {
    const q = sanitizeQueryForApi(`${artist} ${album}`);
    const res = await fetch(`https://api.deezer.com/search/album?q=${encodeURIComponent(q)}&limit=10`);
    if (!res.ok) return null;
    const data = await res.json();
    const items = data.data || [];

    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);

    for (const item of items) {
      const itemArt = cleanString(item.artist ? item.artist.name : '', true);
      const itemAlb = cleanString(item.title || '', false);
      if (evaluateArtistMatch(itemArt, cleanArt) > 0 && hasWordOverlap(cleanAlb, itemAlb)) {
        const cover = item.cover_xl || item.cover_big || item.cover_medium;
        if (cover) {
          return {
            artistName: item.artist.name,
            collectionName: item.title,
            directUrl: cover,
            recordType: item.record_type || 'album',
            seedPlatformUrl: item.link || '',
            source: 'Deezer'
          };
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function fetchCaaFrontImage(endpointUrl) {
  try {
    const res = await fetch(endpointUrl, { headers: { 'User-Agent': 'AlbumArtworkFinder/2.1' } });
    if (!res.ok) return null;
    const data = await res.json();
    const front = (data.images || []).find(img => img.front);
    if (!front) return null;
    let imgUrl = (front.thumbnails && (front.thumbnails['1200'] || front.thumbnails.large)) || front.image;
    if (imgUrl && imgUrl.startsWith('http://')) {
      imgUrl = imgUrl.replace('http://', 'https://');
    }
    return imgUrl;
  } catch (e) {
    return null;
  }
}

async function queryMusicBrainz(artist, album) {
  try {
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    const headers = {
      'Accept': 'application/json',
      'User-Agent': 'AlbumArtworkFinder/2.1 (internal-workplace-tool)'
    };

    const queries = [
      `artist:"${artist}" AND release:"${album}"`,
      `artist:${artist} AND release:${album}`
    ];

    for (const q of queries) {
      const mbUrl = `https://musicbrainz.org/ws/2/release/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;
      const res = await fetch(mbUrl, { headers });
      if (!res.ok) continue;

      const data = await res.json();
      const releases = data.releases || [];
      for (const rel of releases) {
        const relArtistRaw = (rel['artist-credit'] && rel['artist-credit'][0]) ? rel['artist-credit'][0].name : '';
        const relArtistClean = cleanString(relArtistRaw, true);
        const relTitleClean = cleanString(rel.title, false);

        if (relArtistClean && !relArtistClean.includes(cleanArt) && !cleanArt.includes(relArtistClean)) continue;
        if (!hasWordOverlap(cleanAlb, relTitleClean)) continue;

        let imgUrl = await fetchCaaFrontImage(`https://coverartarchive.org/release/${rel.id}`);
        if (!imgUrl && rel['release-group'] && rel['release-group'].id) {
          imgUrl = await fetchCaaFrontImage(`https://coverartarchive.org/release-group/${rel['release-group'].id}`);
        }

        if (imgUrl) {
          return {
            artistName: relArtistRaw || artist,
            collectionName: rel.title,
            directUrl: imgUrl,
            primaryType: (rel['release-group'] && rel['release-group']['primary-type']) || 'Album',
            source: 'Cover Art Archive'
          };
        }
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function queryBandcamp(artist, album) {
  try {
    const cleanArt = cleanString(artist, true);
    const cleanAlb = cleanString(album, false);
    const bcSearchUrl = `https://bandcamp.com/search?q=${encodeURIComponent(`${artist} ${album}`)}`;
    const res = await fetch(bcSearchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const resultBlocks = html.split('<li class="searchresult');
    for (let i = 1; i < resultBlocks.length; i++) {
      const block = resultBlocks[i];
      const typeMatch = block.match(/<div class="itemtype">\s*([a-zA-Z]+)\s*<\/div>/i);
      const bcType = typeMatch ? typeMatch[1].trim().toLowerCase() : '';
      if (bcType !== 'album' && bcType !== 'track') continue;

      const headingMatch = block.match(/<div class="heading">\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
      const subheadMatch = block.match(/<div class="subhead">\s*by\s+([\s\S]*?)<\/div>/i);
      const imgMatch = block.match(/<div class="art">\s*<img[^>]+src="([^"]+)"/i);

      if (!headingMatch || !subheadMatch) continue;

      const pageUrl = headingMatch[1].split('?')[0].trim();
      const titleText = headingMatch[2].replace(/<[^>]+>/g, '').trim();
      const subText = subheadMatch[1].replace(/<[^>]+>/g, '').trim();
      const imgSrc = imgMatch ? imgMatch[1].trim() : '';

      if (evaluateArtistMatch(cleanString(subText, true), cleanArt) > 0 && hasWordOverlap(cleanAlb, cleanString(titleText, false))) {
        const hiResBc = imgSrc.replace(/_\d+\.(jpg|png)$/i, '_10.$1');
        return {
          artistName: subText,
          collectionName: titleText,
          directUrl: hiResBc,
          bandcampPageUrl: pageUrl,
          bcType,
          source: 'Bandcamp'
        };
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function resolveRelease({ artist, album, checkBandcamp }) {
  const isGenericFormat = ['single', 'ep'].includes(cleanString(album, false));
  const cleanQuery = isGenericFormat
    ? sanitizeQueryForApi(artist)
    : sanitizeQueryForApi(`${artist} ${album}`);

  // 1. iTunes Album Search (US, then GB storefront fallback for UK/EU catalog like 21 Singles)
  let results = await queryItunes(cleanQuery, 'album', 'us');
  let validResults = results.filter(r => Boolean(r.artworkUrl100));

  let scored = [];
  if (validResults.length > 0) {
    const hasFullAlbumAlt = validResults.some(r => (r.trackCount || 0) > 1 && !(r.collectionName || '').toLowerCase().includes('booklet'));
    scored = validResults
      .map(item => ({ item, score: scoreItemMatch(item, artist, album, false, hasFullAlbumAlt) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  if (!scored.length && album && !isGenericFormat) {
    const gbResults = await queryItunes(cleanQuery, 'album', 'gb');
    const validGb = gbResults.filter(r => Boolean(r.artworkUrl100));
    if (validGb.length > 0) {
      const hasFullAlbumAlt = validGb.some(r => (r.trackCount || 0) > 1 && !(r.collectionName || '').toLowerCase().includes('booklet'));
      scored = validGb
        .map(item => ({ item, score: scoreItemMatch(item, artist, album, false, hasFullAlbumAlt) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score);
    }
  }

  // 2. iTunes Track Fallback (also runs for generic "Artist - Single" and track-titled queries like Joy Division - Heart and Soul)
  if (!scored.length && album) {
    const songResults = await queryItunes(cleanQuery, 'song', 'us');
    const validSongs = songResults.filter(r => Boolean(r.artworkUrl100));
    if (validSongs.length > 0) {
      const seenCollections = new Set();
      const uniqueCollectionSongs = [];
      for (const s of validSongs) {
        if (!seenCollections.has(s.collectionId)) {
          seenCollections.add(s.collectionId);
          uniqueCollectionSongs.push(s);
        }
      }
      scored = uniqueCollectionSongs
        .map(item => ({ item, score: scoreItemMatch(item, artist, album, true, false) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score);
    }
  }

  let bestMatch = null;
  let sourceName = 'iTunes';
  let isHighConfidence = false;
  let alternates = [];

  if (scored.length > 0) {
    const top = scored[0];
    const cleanArt = cleanString(artist, true);
    const itemArt = cleanString(top.item.artistName, true);
    const threshold = itemArt === cleanArt ? 50 : 80;

    if (top.score >= threshold) {
      bestMatch = top.item;
      const cleanItemAlb = cleanString(bestMatch.collectionName, false);
      const cleanTargetAlb = cleanString(album, false);
      isHighConfidence = top.score >= 145 && (cleanItemAlb === cleanTargetAlb || cleanItemAlb.startsWith(cleanTargetAlb));
      alternates = scored.slice(0, 3).map(alt => ({
        artistName: alt.item.artistName,
        collectionName: alt.item.collectionName,
        releaseType: classifyReleaseType(alt.item, 'iTunes'),
        hiResUrl: alt.item.artworkUrl100.replace(/\d+x\d+bb/, '1500x1500bb'),
        thumbUrl: alt.item.artworkUrl100.replace(/\d+x\d+bb/, '300x300bb'),
        appleMusicUrl: normalizeAppleAlbumUrl(alt.item.collectionViewUrl)
      }));
    }
  }

  // 3. Deezer Fallback
  if (!bestMatch && album && !isGenericFormat) {
    const dzResult = await queryDeezer(artist, album);
    if (dzResult) {
      bestMatch = dzResult;
      sourceName = 'Deezer';
      isHighConfidence = true;
    }
  }

  // 4. MusicBrainz / Cover Art Archive Fallback
  if (!bestMatch && album && !isGenericFormat) {
    const mbResult = await queryMusicBrainz(artist, album);
    if (mbResult) {
      bestMatch = mbResult;
      sourceName = 'Cover Art Archive';
      isHighConfidence = true;
    }
  }

  // 5. Direct Bandcamp Fallback
  if (!bestMatch && album && checkBandcamp && !isGenericFormat) {
    const bcResult = await queryBandcamp(artist, album);
    if (bcResult) {
      bestMatch = bcResult;
      sourceName = 'Bandcamp';
      isHighConfidence = true;
    }
  }

  if (!bestMatch) {
    return { status: 'Not Found' };
  }

  const hiResUrl = bestMatch.directUrl
    ? bestMatch.directUrl
    : bestMatch.artworkUrl100.replace(/\d+x\d+bb/, '1500x1500bb');
  const releaseType = classifyReleaseType(bestMatch, sourceName);
  const appleUrl = normalizeAppleAlbumUrl(bestMatch.collectionViewUrl);

  return {
    status: 'Found',
    matchedArtist: bestMatch.artistName,
    matchedTitle: bestMatch.collectionName,
    releaseType,
    source: sourceName,
    isHighConfidence,
    hiResUrl,
    alternates,
    appleMusicUrl: appleUrl,
    seedPlatformUrl: appleUrl || bestMatch.seedPlatformUrl || '',
    bandcampPageUrl: bestMatch.bandcampPageUrl || null
  };
}
