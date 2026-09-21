import { chromium } from 'playwright'
const OUT = '/tmp/claude-0/demo/shots'
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch({ executablePath: CHROME })
async function session(email, viewport = { width: 1440, height: 940 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', 'plumbline-demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForTimeout(2500)
  return page
}
async function scrollMain(page, px) {
  await page.evaluate((p) => {
    const el = [...document.querySelectorAll('*')].find(
      (e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY === 'auto',
    )
    if (el) el.scrollTop = p
    else window.scrollTo(0, p)
  }, px)
  await page.waitForTimeout(800)
}
const pm = await session('pm@ridgeline.test')
await pm.getByText('Harbor Point Phase II').first().click()
await pm.waitForTimeout(2600)
await pm.getByText('Budget', { exact: true }).first().click()
await pm.waitForTimeout(1700)
await pm.getByText('05 00 00.S').first().click()
await pm.waitForTimeout(1600)
await scrollMain(pm, 700)
await pm.screenshot({ path: `${OUT}/09-cost-detail.png` })
console.log('SHOT cost-detail')

await scrollMain(pm, 0)
await pm.getByText('Contracts', { exact: true }).first().click()
await pm.waitForTimeout(1700)
await pm.getByRole('tab', { name: /Lien/ }).click()
await pm.waitForTimeout(2000)
await scrollMain(pm, 420)
await pm.screenshot({ path: `${OUT}/11-statutory.png` })
console.log('SHOT statutory')
await browser.close()
