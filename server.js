// server.js – Fulton County Property Owner Lookup API

const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

/** Normalize address to USPS abbreviations and strip city/state/zip */
function normalizeAddress(address) {
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CENTRE':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY',
    'EXTENSION':'EXT','FREEWAY':'FWY','GROVE':'GRV','HEIGHTS':'HTS',
    'HIGHWAY':'HWY','HOLLOW':'HOLW','JUNCTION':'JCT','MOTORWAY':'MTWY',
    'OVERPASS':'OPAS','PARK':'PARK','POINT':'PT','ROUTE':'RTE',
    'SKYWAY':'SKWY','SQUARE':'SQ','TURNPIKE':'TPKE',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W',
    'NORTHEAST':'NE','NORTHWEST':'NW','SOUTHEAST':'SE','SOUTHWEST':'SW',
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING','MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (let [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

/** Scrape qPublic Fulton County site for owner info */
async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1) Navigate to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil:'networkidle2', timeout:30000 }
    );

    // 2) Accept terms if present
    try {
      const btn = await page.$('input[type="submit"][value*="Agree"], input[type="button"][value*="Accept"]');
      if (btn) {
        await btn.click();
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      // continue if no button
    }

    // 3) Wait for "Search by Location Address" input
    //    Placeholder value: "Enter address or range of address (ex: 1200-1299 Main)"
    const addressSelector = 'input[placeholder*="Enter address or range of address"]';
    await page.waitForSelector(addressSelector, { timeout:10000 });

    // 4) Type normalized address
    const norm = normalizeAddress(address);
    await page.click(addressSelector, { clickCount: 3 });
    await page.type(addressSelector, norm);

    // 5) Click the Search button adjacent to that input
    //    The Search button is an <input> with value="Search"
    await page.click('input[type="submit"][value="Search"]');

    // 6) Wait for results grid and click first parcel link
    await page.waitForSelector('table.searchResultsGrid a', { timeout:15000 });
    await page.click('table.searchResultsGrid a');

    // 7) Wait for the "Most Current Owner" cell
    await page.waitForSelector('td:has-text("Most Current Owner")', { timeout:15000 });

    // 8) Extract owner & mailing address
    const { owner, mailing } = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g,' ').trim();
      let o='Not found', m='Not found';
      const cells = Array.from(document.querySelectorAll('td'));
      const ownerTd = cells.find(td => /Most Current Owner/i.test(td.textContent));
      if (ownerTd?.nextElementSibling) o = clean(ownerTd.nextElementSibling.textContent);
      const mailTd = cells.find(td => /Mailing Address/i.test(td.textContent));
      if (mailTd?.nextElementSibling) m = clean(mailTd.nextElementSibling.textContent);
      return { owner:o, mailing:m };
    });

    return { success:true, owner_name:owner, mailing_address:mailing };
  } catch (err) {
    console.error('Scrape error:', err);
    return { success:false, error:err.message };
  } finally {
    await browser.close();
  }
}

// API endpoints
app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ success:false, error:'address field required' });
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Root and health routes
app.get('/',      (req, res) => res.send('Fulton Scraper API running'));
app.get('/health',(req, res) => res.json({ ok:true, ts:Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
