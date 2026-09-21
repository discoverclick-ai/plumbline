import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
const OUT = '/tmp/claude-0/demo/shots'
await mkdir(OUT, { recursive: true })
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const browser = await chromium.launch({ executablePath: CHROME })
async function session(email, viewport = { width: 1440, height: 900 }) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 })
  await page.goto('http://127.0.0.1:5173/', { waitUntil: 'networkidle' })
  await page.fill('input[name="email"]', 'x')
  await page.fill('input[name="email"]', email)
  await page.fill('input[name="password"]', 'plumbline-demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForTimeout(3000)
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
  await page.waitForTimeout(700)
}
const pm = await session('pm@ridgeline.test')
await pm.screenshot({ path: `${OUT}/01-portfolio.png` })
await pm.getByText('Harbor Point Phase II').first().click()
await pm.waitForTimeout(3000)
await pm.screenshot({ path: `${OUT}/02-project.png` })
await pm.getByText('Budget', { exact: true }).first().click()
await pm.waitForTimeout(1800)
await pm.getByText('05 00 00.S').first().click()
await pm.waitForTimeout(1600)
await scrollMain(pm, 640)
await pm.screenshot({ path: `${OUT}/03-budget-costs.png` })
await scrollMain(pm, 0)
await pm.getByText('Contracts', { exact: true }).first().click()
await pm.waitForTimeout(1800)
await pm.getByRole('tab', { name: /Lien/ }).click()
await pm.waitForTimeout(2200)
await pm.screenshot({ path: `${OUT}/04-lien-bond.png` })

const trade = await session('foreman@vega.test')
await trade.getByText('Harbor Point Phase II').first().click()
await trade.waitForTimeout(3000)
await trade.screenshot({ path: `${OUT}/05-trade-partner.png` })

const phone = await session('super@ridgeline.test', { width: 390, height: 844 })
await phone.getByText('Harbor Point Phase II').first().click()
await phone.waitForTimeout(3000)
await phone.screenshot({ path: `${OUT}/06-phone.png` })
console.log('DONE')
await browser.close()
