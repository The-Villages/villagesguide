import fs from 'node:fs/promises';

const {
  CANVA_CLIENT_ID: ID,
  CANVA_CLIENT_SECRET: SECRET,
  CANVA_REFRESH_TOKEN: RT,
  CANVA_DESIGN_ID: DESIGN
} = process.env;

const API = 'https://api.canva.com/rest/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- refresh access token (this rotates the refresh token) ---
const tok = await (await fetch(`${API}/oauth/token`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64')
  },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT })
})).json();

if (!tok.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tok));

// Hand the rotated token back to the workflow immediately, before anything else can fail
await fs.writeFile('.new-refresh-token', tok.refresh_token);

const H = { Authorization: `Bearer ${tok.access_token}` };

// --- change detection ---
const meta = await (await fetch(`${API}/designs/${DESIGN}`, { headers: H })).json();
const stamp = String(meta.design?.updated_at ?? '');
let last = '';
try { last = (await fs.readFile('.canva-state', 'utf8')).trim(); } catch {}

if (stamp && stamp === last) {
  console.log('No changes since last sync. Exiting.');
  await fs.writeFile('.changed', 'false');
  process.exit(0);
}

// --- export helper ---
async function exportDesign(format) {
  const res = await fetch(`${API}/exports`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ design_id: DESIGN, format })
  });
  const job = await res.json();

  if (!job.job) {
    throw new Error(`Export request rejected (${res.status}): ${JSON.stringify(job)}`);
  }

  let id = job.job.id, state = job.job;
  while (state.status === 'in_progress') {
    await sleep(2500);
    const poll = await (await fetch(`${API}/exports/${id}`, { headers: H })).json();
    if (!poll.job) throw new Error(`Poll failed: ${JSON.stringify(poll)}`);
    state = poll.job;
  }
  if (state.status !== 'success') throw new Error(JSON.stringify(state.error));
  return state.urls;
}

async function save(url, path) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await fs.writeFile(path, buf);
}

// --- export all pages as JPG, high quality (returned in Canva page order) ---
const pages = await exportDesign({ type: 'jpg', quality: 100, export_quality: 'regular' });
console.log(`Canva returned ${pages.length} raw pages`);

if (pages.length < 26) {
  throw new Error(`Expected at least 26 pages in Canva (1-24 normal, 25/26 map halves), got ${pages.length}. Check the design hasn't been reordered.`);
}

// --- remap Canva's 26-page layout to the site's expected 24-page layout ---
// Canva 1-11   -> output 1-11        (unchanged)
// Canva 12     -> output 12a.jpg     (mobile full map)
// Canva 13     -> discarded          (duplicate of 12, exists only for Canva-side naming)
// Canva 14-24  -> output 14-24       (unchanged)
// Canva 25     -> output 12.jpg      (PC left half of big map)
// Canva 26     -> output 13.jpg      (PC right half of big map)

for (let i = 1; i <= 11; i++) await save(pages[i - 1], `${i}.jpg`);
await save(pages[11], '12a.jpg');       // Canva page 12
// pages[12] (Canva page 13) intentionally skipped
for (let i = 14; i <= 24; i++) await save(pages[i - 1], `${i}.jpg`);
await save(pages[24], '12.jpg');        // Canva page 25
await save(pages[25], '13.jpg');        // Canva page 26

// --- export PDF (this stays in true Canva order, 26 pages, which is fine for the download link) ---
const [pdf] = await exportDesign({ type: 'pdf' });
await save(pdf, 'villagesguide.pdf');

// --- page count for the site (24 real pages) ---
await fs.writeFile('pages.json', JSON.stringify({ count: 24, mapSpread: [12, 13] }, null, 2));

await fs.writeFile('.canva-state', stamp);
await fs.writeFile('.changed', 'true');
console.log('Done. 24 pages remapped + PDF.');
