import fs from 'node:fs/promises';
import sharp from 'sharp';

const {
  CANVA_CLIENT_ID: ID,
  CANVA_CLIENT_SECRET: SECRET,
  CANVA_REFRESH_TOKEN: RT,
  CANVA_DESIGN_ID: DESIGN
} = process.env;

const API = 'https://api.canva.com/rest/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- refresh access token (rotates RT) ---
const tok = await (await fetch(`${API}/oauth/token`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Authorization: 'Basic ' + Buffer.from(`${ID}:${SECRET}`).toString('base64')
  },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: RT })
})).json();

if (!tok.access_token) throw new Error('Token refresh failed: ' + JSON.stringify(tok));

// Hand the rotated token back to the workflow immediately
await fs.writeFile('.new-refresh-token', tok.refresh_token);

const H = { Authorization: `Bearer ${tok.access_token}` };

// --- change detection ---
const meta = await (await fetch(`${API}/designs/${DESIGN}`, { headers: H })).json();
const stamp = String(meta.design?.updated_at ?? '');
let last = '';
try { last = (await fs.readFile('.canva-state', 'utf8')).trim(); } catch {}

if (stamp && stamp === last) {
  console.log('No changes. Exiting.');
  await fs.writeFile('.changed', 'false');
  process.exit(0);
}

// --- export helper ---
async function exportDesign(format) {
  const job = await (await fetch(`${API}/exports`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ design_id: DESIGN, format })
  })).json();

  let id = job.job.id, state = job.job;
  while (state.status === 'in_progress') {
    await sleep(2500);
    state = (await (await fetch(`${API}/exports/${id}`, { headers: H })).json()).job;
  }
  if (state.status !== 'success') throw new Error(JSON.stringify(state.error));
  return state.urls;
}

async function save(url, path) {
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
  await fs.writeFile(path, buf);
}

// --- pages (URLs come back in page order) ---
const pages = await exportDesign({ type: 'jpg', quality: 90 });
console.log(`Exporting ${pages.length} pages`);
for (let i = 0; i < pages.length; i++) await save(pages[i], `${i + 1}.jpg`);

// --- PDF ---
const [pdf] = await exportDesign({ type: 'pdf' });
await save(pdf, 'villagesguide.pdf');

// --- stitch the mobile map: 12 + 13 side by side ---
const m = await sharp('12.jpg').metadata();
await sharp({
  create: { width: m.width * 2, height: m.height, channels: 3, background: '#ffffff' }
})
  .composite([
    { input: '12.jpg', left: 0, top: 0 },
    { input: '13.jpg', left: m.width, top: 0 }
  ])
  .jpeg({ quality: 90 })
  .toFile('12a.jpg');

await fs.writeFile('.canva-state', stamp);
await fs.writeFile('.changed', 'true');
console.log(`Done. ${pages.length} pages + PDF + stitched map.`);
