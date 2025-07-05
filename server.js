// server.js – Fulton County Property Owner Lookup API

const express   = require('express');
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
    'MARTIN LUTHER KING JR':'M L KING JR','MARTIN LUTHER KING':'M L KING',
    'MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (let [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  // Strip trailing GA/ZIP
  s = s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

/** Scrape the qPublic Fulton County site for owner info */
async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1) Go to search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil:'networkidle2', timeout:30000 }
    );

    // 2) Click the “Accept” or “I Agree” button if it appears
    //    Valid selectors: input[type="submit"][value*="Accept"], button span with text
    const acceptBtn = await page.$(
      'input[type="submit"][value*="Accept"], input[type="button"][value*="Agree"], button:has-text("Agree")'
    );
    if (acceptBtn) {
      await acceptBtn.click();
      await page.waitForTimeout(1000);
    }

    // 3) Choose the address search input
    let addressSel = 'input[placeholder*="Enter address"]';
    if (!await page.$(addressSel)) {
      addressSel = '#SearchTextBox';
    }
    await page.waitForSelector(addressSel, { timeout:10000 });

    // 4) Type the normalized address
    const norm = normalizeAddress(address);
    await page.click(addressSel, { clickCount:3 });
    await page.type(addressSel, norm);

    // 5) Click the Search button (or press Enter)
    const searchBtn = await page.$('input[type="submit"][value="Search"], button:has-text("Search")');
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // 6) Wait for the results and click the first parcel link
    await page.waitForSelector('table.searchResultsGrid a', { timeout:15000 });
    await page.click('table.searchResultsGrid a');

    // 7) Wait for the “Most Current Owner” cell
    await page.waitForSelector('td:has-text("Most Current Owner")', { timeout:15000 });

    // 8) Extract owner name & mailing address
    const { owner, mailing } = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g,' ').trim();
      let o='Not found', m='Not found';
      // Owner
      const ownerTd = [...document.querySelectorAll('td')]
        .find(td => /Most Current Owner/i.test(td.textContent));
      if (ownerTd?.nextElementSibling) {
        o = clean(ownerTd.nextElementSibling.textContent);
      }
      // Mailing
      const mailTd = [...document.querySelectorAll('td')]
        .find(td => /Mailing Address/i.test(td.textContent));
      if (mailTd?.nextElementSibling) {
        m = clean(mailTd.nextElementSibling.textContent);
      }
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

// Define API endpoints
app.post('/fulton-property-search', async (req,res) => {
  const { address } = req.body||{};
  if (!address) return res.status(400).json({ success:false, error:'address field required' });
  const data = await fetchOwnerData(address);
  res.json(data);
});

// Health & root routes
app.get('/',    (req,res)=>res.send('Fulton Scraper API running'));
app.get('/health',(req,res)=>res.json({ ok:true, ts:Date.now() }));

const PORT = process.env.PORT||8080;
app.listen(PORT, ()=>console.log(`API listening on ${PORT}`));
