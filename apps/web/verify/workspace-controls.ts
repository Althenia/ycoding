import { decodeBoolean, decodeString, type launchBrowser } from "./cdp"

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

export async function chooseWorkspace(page: Page, choice: string | number): Promise<string> {
  for (let attempt = 0; attempt < 80 && await page.evaluate(`document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]').getAttribute('aria-disabled')==='true'`, decodeBoolean); attempt++) await Bun.sleep(25)
  await page.evaluate(`document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]').click()`)
  for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.custom-select__option')`); attempt++) await Bun.sleep(25)
  const label = await page.evaluate(`(()=>{const options=[...document.querySelectorAll('.custom-select__option')].filter(e=>e.getClientRects().length&&!e.closest('[inert]')),choice=${JSON.stringify(choice)},option=typeof choice==='number'?options[choice]:options.find(e=>e.textContent.toLowerCase().includes(choice.toLowerCase()));if(!option)throw new Error('Workspace option missing');const label=option.querySelector('.custom-select__option-body > span').textContent;option.click();const confirm=document.querySelector('.custom-select__confirm');if(confirm?.getClientRects().length)confirm.click();return label})()`, decodeString)
  for (let attempt = 0; attempt < 80 && await page.evaluate(`!!document.querySelector('.custom-select__option')`, decodeBoolean); attempt++) await Bun.sleep(25)
  return label
}
