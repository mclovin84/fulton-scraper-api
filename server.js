const express = require('express');
const puppeteer = require('puppeteer');

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

// Global browser instance to reuse
let globalBrowser = null;

async function getBrowser() {
  if (!globalBrowser) {
    globalBrowser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--memory-pressure-off'
      ]
    });
  }
  return globalBrowser;
}

async function fetchOwnerData(address) {
  let page = null;
  const timeout = 30000; // 30 second timeout
  
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    
    // Set a smaller viewport to reduce memory usage
    await page.setViewport({ width: 800, height: 600 });
    
    // Set timeout for all operations
    page.setDefaultTimeout(timeout);
    
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'domcontentloaded', timeout }
    );

    const title = await page.title();
    if (title.includes('Cloudflare') || title.includes('Attention')) {
      throw new Error('Blocked by Cloudflare - use n8n + Airtop workflow instead');
    }

    const norm = normalizeAddress(address);
    
    // Simple input finding and filling
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.type('input[type="text"]', norm);
    await page.keyboard.press('Enter');

    await page.waitForTimeout(3000);
    
    // Try to click first result if available
    try {
      await page.waitForSelector('table a', { timeout: 5000 });
      await page.click('table a');
      await page.waitForTimeout(2000);
    } catch (e) {
      // No results found, continue
    }

    // Extract data with timeout protection
    const result = await Promise.race([
      page.evaluate(() => {
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
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Page evaluation timeout')), 10000))
    ]);

    return { success: true, owner_name: result.owner, mailing_address: result.mailing };
    
  } catch (err) {
    console.error('Scraping error:', err.message);
    return { success: false, error: err.message };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        console.error('Error closing page:', e.message);
      }
    }
  }
}

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, closing browser...');
  if (globalBrowser) {
    await globalBrowser.close();
  }
  process.exit(0);
});

app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success: false, error: 'address field required' });
  }
  
  // Add request timeout
  const timeoutId = setTimeout(() => {
    res.status(408).json({ success: false, error: 'Request timeout' });
  }, 25000);
  
  try {
    const data = await fetchOwnerData(address);
    clearTimeout(timeoutId);
    res.json(data);
  } catch (error) {
    clearTimeout(timeoutId);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/', (_, res) => res.send('Fulton Scraper API running'));
app.get('/health', (_, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log(`API listening on port ${PORT}`));
