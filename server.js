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
    // 1) Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil: 'networkidle2', timeout: 30000 }
    );

    // 2) Accept terms if present
    try {
      const agreeBtn = await page.$('input[type="button"][value*="Agree"], input[type="submit"][value*="Agree"]');
      if (agreeBtn) {
        await agreeBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      // Continue if no agreement button
    }

    // 3) Wait for the specific address input field using the ID you provided
    await page.waitForSelector('#ctlBodyPane_ctl01_ctl01_txtAddress', { timeout: 10000 });
    
    // 4) Type the normalized address
    const norm = normalizeAddress(address);
    console.log(`Typing normalized address: ${norm}`);
    
    await page.click('#ctlBodyPane_ctl01_ctl01_txtAddress', { clickCount: 3 });
    await page.type('#ctlBodyPane_ctl01_ctl01_txtAddress', norm);
    
    // Small delay to let any autocomplete settle
    await page.waitForTimeout(500);

    // 5) Click the search button using the ID from the onkeypress attribute
    await page.click('#ctlBodyPane_ctl01_ctl01_btnSearch');

    // 6) Wait for results table
    await page.waitForSelector('table.searchResultsGrid a, table a[href*="KeyValue"]', { timeout: 15000 });
    
    // Click first result
    const firstResult = await page.$('table.searchResultsGrid a, table a[href*="KeyValue"]');
    await firstResult.click();

    // 7) Wait for the property details page to load
    await page.waitForFunction(
      () => {
        const text = document.body.innerText;
        return text.includes('Most Current Owner') || text.includes('Owner Name') || text.includes('Current Owner');
      },
      { timeout: 15000 }
    );

    // 8) Extract owner & mailing address
    const result = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g, ' ').trim();
      let owner = 'Not found';
      let mailing = 'Not found';
      
      // Get all table cells
      const cells = Array.from(document.querySelectorAll('td'));
      
      for (let i = 0; i < cells.length; i++) {
        const cellText = cells[i].textContent || '';
        
        // Look for owner
        if (/Most Current Owner/i.test(cellText)) {
          // The owner name is typically in the next cell
          if (cells[i + 1]) {
            owner = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            owner = clean(cells[i].nextElementSibling.textContent);
          }
        }
        
        // Look for mailing address
        if (/Mailing Address/i.test(cellText)) {
          // The mailing address is typically in the next cell
          if (cells[i + 1]) {
            mailing = clean(cells[i + 1].textContent);
          } else if (cells[i].nextElementSibling) {
            mailing = clean(cells[i].nextElementSibling.textContent);
          }
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
    console.error('Scrape error:', err);
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
  console.log(`Searching for address: ${address}`);
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Root and health routes
app.get('/', (req, res) => res.send('Fulton Scraper API running'));
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
