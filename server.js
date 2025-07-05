// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

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
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&PageType=Search',
      { waitUntil: 'domcontentloaded', timeout: 30000 }
    );

    // Wait for JavaScript to initialize
    await page.waitForTimeout(3000);

    // Handle terms if present
    try {
      await page.click('input[value*="Agree"]');
      await page.waitForTimeout(2000);
    } catch (e) {
      // No terms to accept
    }

    // Wait for and interact with the address input
    await page.waitForSelector('#ctlBodyPane_ctl01_ctl01_txtAddress', { 
      visible: true, 
      timeout: 10000 
    });

    // Type the address
    const norm = normalizeAddress(address);
    await page.type('#ctlBodyPane_ctl01_ctl01_txtAddress', norm);

    // Press Enter to search
    await page.keyboard.press('Enter');

    // Wait for results or navigation
    await page.waitForTimeout(3000);

    // Click first result if we're on results page
    try {
      await page.waitForSelector('table.searchResultsGrid a', { timeout: 5000 });
      await page.click('table.searchResultsGrid tbody tr:first-child a');
      await page.waitForTimeout(3000);
    } catch (e) {
      // Might already be on property page
    }

    // Extract owner info
    const result = await page.evaluate(() => {
      const clean = txt => (txt || '').replace(/\s+/g, ' ').trim();
      let owner = 'Not found';
      let mailing = 'Not found';
      
      const cells = Array.from(document.querySelectorAll('td'));
      
      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent || '';
        
        if (/Most Current Owner/i.test(cellText) && cells[i + 1]) {
          owner = clean(cells[i + 1].textContent);
        }
        
        if (/Mailing Address/i.test(cellText) && cells[i + 1]) {
          mailing = clean(cells[i + 1].textContent);
        }
      }
      
      return { owner, mailing };
    });

    return {
      success: true,
      owner_name: result.owner,
      mailing_address: result.mailing
    };

  } catch (err) {
    console.error('Error:', err.message);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success: false, error: 'address field required' });
  }
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
