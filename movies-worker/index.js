const ALLOWED = 'https://filmyy7.pages.dev';
const HEADERS = {
  'Access-Control-Allow-Origin': ALLOWED,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const B2_ENDPOINT = 'https://s3.eu-central-003.backblazeb2.com';
const B2_BUCKET   = 'mymusic678';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: HEADERS });
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/movies') {
      const s3Url = `${B2_ENDPOINT}/${B2_BUCKET}?list-type=2&prefix=movies%2F&delimiter=%2F`;
      const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g,'').slice(0,15) + 'Z';
      const dateShort = date.slice(0,8);
      const signKey = async (k, msg) => {
        const imported = await crypto.subtle.importKey('raw', k, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
        return new Uint8Array(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(msg)));
      };
      const hex = buf => Array.from(buf).map(b=>b.toString(16).padStart(2,'0')).join('');
      const hash = async msg => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg))));
      const payloadHash = await hash('');
      const credScope = `${dateShort}/eu-central-003/s3/aws4_request`;
      const canonicalRequest = `GET\n/${B2_BUCKET}\ndelimiter=%2F&list-type=2&prefix=movies%2F\nhost:s3.eu-central-003.backblazeb2.com\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n\nhost;x-amz-content-sha256;x-amz-date\n${payloadHash}`;
      const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credScope}\n${await hash(canonicalRequest)}`;
      const kDate    = await signKey(new TextEncoder().encode('AWS4' + env.B2_APP_KEY), dateShort);
      const kRegion  = await signKey(kDate, 'eu-central-003');
      const kService = await signKey(kRegion, 's3');
      const kSigning = await signKey(kService, 'aws4_request');
      const signature = hex(await signKey(kSigning, stringToSign));
      const auth = `AWS4-HMAC-SHA256 Credential=${env.B2_KEY_ID}/${credScope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`;

      const res = await fetch(`${B2_ENDPOINT}/${B2_BUCKET}?list-type=2&prefix=movies%2F&delimiter=%2F`, {
        headers: {
          'Authorization': auth,
          'x-amz-date': date,
          'x-amz-content-sha256': payloadHash
        }
      });

      const xml = await res.text();
      const folders = [...xml.matchAll(/<Prefix>movies\/([^<\/]+)\/<\/Prefix>/g)].map(m => ({
        id: m[1],
        title: m[1].replace(/_/g, ' '),
        master: `${B2_ENDPOINT}/${B2_BUCKET}/movies/${m[1]}/master.m3u8`
      }));

      return new Response(JSON.stringify(folders), {
        headers: { ...HEADERS, 'Content-Type': 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/upload') {
      const { movie_url, movie_name } = await request.json();
      const res = await fetch(
        'https://api.github.com/repos/gity678/movies/actions/workflows/upload_movie.yml/dispatches',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'movies-worker'
          },
          body: JSON.stringify({
            ref: 'main',
            inputs: { movie_url, movie_name }
          })
        }
      );
      return new Response(JSON.stringify({ ok: res.status === 204 }), {
        headers: { ...HEADERS, 'Content-Type': 'application/json' }
      });
    }

    return new Response('OK', { headers: HEADERS });
  }
};