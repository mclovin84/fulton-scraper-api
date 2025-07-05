// server.js – Fulton County Property Owner Lookup API

const express   = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

function normalizeAddress(address) {
  // (same abbreviation logic as before)
  const ABBREV = {/* … USPS mappings … */};
  let s = address.toUpperCase().replace(/[.,#]/g,' ');
  for (const [k,v] of Object.entries(ABBREV)) {
    s = s.replace(new RegExp(`\\b${k}\\b`,'g'), v);
  }
  return s.replace(/\b(ATLANTA|AUGUSTA|COLUMBUS|MACON|SAVANNAH|ATHENS|GA|GEORGIA)\b.*$/,'').trim();
}

async function fetchOwnerData(address) {
  const browser = await puppeteer.connect({
    browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT
  });
  const page = await browser.newPage();

  try {
    await page.goto(
      'https://qpublic.schneidercorp.com/Application.aspx?App=FultonCountyGA&Layer=Parcels&PageType=Search',
      { waitUntil:'networkidle2', timeout:30000 }
    );

    // Accept terms if present
    const [agree] = await page.$x("//input[contains(@value,'Agree') or contains(@value,'Accept')]");
    if (agree) {
      await agree.click();
      await page.waitForTimeout(1000);
    }

    // 1) Locate the "Search by Location Address" label and get its following input
    const [label] = await page.$x("//label[contains(., 'Search by Location Address')]");
    if (!label) throw new Error('Address label not found');
    const inputHandle = await page.evaluateHandle(el => el.nextElementSibling.querySelector('input'), label);
    if (!inputHandle) throw new Error('Address input not found');

    // 2) Type normalized address
    const norm = normalizeAddress(address);
    await inputHandle.click({ clickCount: 3 });
    await inputHandle.type(norm);

    // 3) Click the Search button near that input
    const [searchBtn] = await page.$x("//button[contains(., 'Search') or //input[@value='Search']]");
    if (searchBtn) {
      await searchBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // 4) Wait for results and click first link
    await page.waitForXPath("//table[contains(@class,'searchResultsGrid')]//a", { timeout:15000 });
    const [firstLink] = await page.$x("//table[contains(@class,'searchResultsGrid')]//a");
    await firstLink.click();

    // 5) Wait for owner section
    await page.waitForXPath("//td[contains(., 'Most Current Owner')]", { timeout:15000 });

    // 6) Scrape owner & mailing
    const result = await page.evaluate(() => {
      const clean = t => t.replace(/\s+/g,' ').trim();
      const cells = Array.from(document.querySelectorAll('td'));
      let owner='Not found', mailing='Not found';
      for (const td of cells) {
        if (/Most Current Owner/i.test(td.textContent) && td.nextElementSibling) {
          owner = clean(td.nextElementSibling.textContent);
        }
        if (/Mailing Address/i.test(td.textContent) && td.nextElementSibling) {
          mailing = clean(td.nextElementSibling.textContent);
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

app.post('/fulton-property-search', async (req, res) => {
  const { address } = req.body || {};
  if (!address) return res.status(400).json({ success: false, error: 'address required' });
  res.json(await fetchOwnerData(address));
});

app.get('/',      (_,res) => res.send('Fulton Scraper API running'));
app.get('/health',(_,res) => res.json({ ok:true, ts: Date.now() }));

app.listen(process.env.PORT || 8080, () => {
  console.log('API listening');
});
