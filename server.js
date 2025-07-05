const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

function normalizeAddress(address) {
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY','EXTENSION':'EXT',
    'FREEWAY':'FWY','HEIGHTS':'HTS','HIGHWAY':'HWY','JUNCTION':'JCT',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W',
    'NORTHEAST':'NE','NORTHWEST':'NW','SOUTHEAST':'SE','SOUTHWEST':'SW',
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING','MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (const [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

async function fetchOwnerData(address) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 60000 }
    );

    const title = await page.title();
    if (title.includes('Cloudflare') || title.includes('Attention')) {
      throw new Error('Blocked by Cloudflare bot protection');
    }

    const norm = normalizeAddress(address);
    const selectors = [
      'input[name="txtSearchText"]',
      'input[placeholder*="address"]',
      'input[type="text"]'
    ];
    let inputEl = null;
    for (const sel of selectors) {
      inputEl = await page.$(sel);
      if (inputEl) break;
    }
    if (!inputEl) {
      throw new Error('Address input field not found');
    }
    await inputEl.click({ clickCount: 3 });
    await inputEl.type(norm);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(5000);
    try {
      await page.waitForSelector('table.searchResultsGrid a', { timeout: 10000 });
      await page.click('table.searchResultsGrid tbody tr:first-child a');
      await page.waitForTimeout(3000);
    } catch {}

    const { owner, mailing } = await page.evaluate(() => {
      const clean = txt => (txt||'').replace(/\s+/g,' ').trim();
      let owner = 'Not found', mailing = 'Not found';
      const cells = Array.from(document.querySelectorAll('td'));
      for (let i = 0; i < cells.length; i++) {
        const txt = cells[i].textContent || '';
        if (/Most Current Owner/i.test(txt) && cells[i+1]) {
          owner = clean(cells[i+1].textContent);
        }
        if (/Mailing Address/i.test(txt) && cells[i+1]) {
          mailing = clean(cells[i+1].textContent);
        }
      }
      return { owner, mailing };
    });

    return { success: true, owner_name: owner, mailing_address: mailing };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success: false, error: 'address field required' });
  }
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/', (_, res) => res.send('Fulton Scraper API running'));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
