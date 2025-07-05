// server.js – Fulton County Property Owner Lookup API

const express   = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

function normalizeAddress(address) {
  // Same USPS abbreviation mapping as before
  const ABBREV = {
    'STREET':'ST','AVENUE':'AVE','BOULEVARD':'BLVD','DRIVE':'DR',
    'ROAD':'RD','LANE':'LN','COURT':'CT','CIRCLE':'CIR','PLACE':'PL',
    'PARKWAY':'PKWY','TRAIL':'TRL','TERRACE':'TER','PLAZA':'PLZ',
    'ALLEY':'ALY','BRIDGE':'BRG','BYPASS':'BYP','CAUSEWAY':'CSWY',
    'CENTER':'CTR','CROSSING':'XING','EXPRESSWAY':'EXPY','EXTENSION':'EXT',
    'FREEWAY':'FWY','HEIGHTS':'HTS','HIGHWAY':'HWY','JUNCTION':'JCT',
    'NORTH':'N','SOUTH':'S','EAST':'E','WEST':'W','MLK':'M L KING'
  };
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (const [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  // Strip trailing city/state/zip
  s = s.replace(/\b(ATLANTA|GA|GEORGIA)\b.*$/,'').trim();
  return s.replace(/\s+/g,' ');
}

async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    // 1) Load the search page
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil:'networkidle2', timeout:30000 }
    );

    // 2) Accept terms if they appear
    const agreeBtn = await page.$('input[type=button][value*="Agree"], input[type=submit][value*="Agree"]');
    if (agreeBtn) {
      await agreeBtn.click();
      await page.waitForTimeout(1000);
    }

    // 3) Normalize and split into number + street name
    const norm = normalizeAddress(address);
    const parts = norm.split(' ');
    const streetNumber = parts.shift();
    const streetName   = parts.join(' ');

    // 4) Fill Street Number
    await page.waitForSelector('input[name="txtStreetNumber"]',{ timeout:10000 });
    await page.click('input[name="txtStreetNumber"]',{ clickCount:3 });
    await page.type('input[name="txtStreetNumber"]', streetNumber);

    // 5) Fill Street Name
    await page.waitForSelector('input[name="txtStreetName"]',{ timeout:10000 });
    await page.click('input[name="txtStreetName"]',{ clickCount:3 });
    await page.type('input[name="txtStreetName"]', streetName);

    // 6) Click Search
    await page.click('input[type=submit][value="Search"]');

    // 7) Wait for and click first result link
    await page.waitForSelector('table.searchResultsGrid a',{ timeout:15000 });
    await page.click('table.searchResultsGrid a');

    // 8) Wait for “Most Current Owner”
    await page.waitForXPath("//td[contains(.,'Most Current Owner')]",{ timeout:15000 });

    // 9) Extract owner & mailing
    const result = await page.evaluate(() => {
      const clean = txt => txt.replace(/\s+/g,' ').trim();
      const tds = Array.from(document.querySelectorAll('td'));
      let owner='Not found', mail='Not found';
      for (const td of tds) {
        if (/Most Current Owner/i.test(td.textContent) && td.nextElementSibling) {
          owner = clean(td.nextElementSibling.textContent);
        }
        if (/Mailing Address/i.test(td.textContent) && td.nextElementSibling) {
          mail = clean(td.nextElementSibling.textContent);
        }
      }
      return { owner, mail };
    });

    return {
      success: true,
      owner_name:  result.owner,
      mailing_address: result.mail
    };

  } catch (err) {
    console.error('Error scraping:', err);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) {
    return res.status(400).json({ success:false, error:'address field required' });
  }
  const data = await fetchOwnerData(address);
  res.json(data);
});

app.get('/',      (_,res) => res.send('Fulton Scraper API running'));
app.get('/health',(_,res) => res.json({ ok:true, ts: Date.now() }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
