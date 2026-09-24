// Toolbar icon (or Alt+Shift+T): switch new tabs between Tabboard and Chrome's own new tab page.
// The choice is kept in chrome.storage so the icon and the page share it.
const CHROME_NTP = 'chrome://new-tab-page/';
chrome.action.onClicked.addListener(async (tab) => {
  const { ntmode = 'tabboard' } = await chrome.storage.local.get('ntmode');
  const next = ntmode === 'chrome' ? 'tabboard' : 'chrome';
  await chrome.storage.local.set({ ntmode: next });
  paintAction(next);
  const url = tab.url || '';
  const onNewTab = url.startsWith(chrome.runtime.getURL('')) || /^chrome:\/\/(new-tab-page|newtab)/.test(url);
  const target = next === 'chrome' ? CHROME_NTP : 'chrome://newtab/';
  if (onNewTab) chrome.tabs.update(tab.id, { url: target });
  else if (next === 'tabboard') chrome.tabs.create({ url: target });
});
// the icon's tooltip and badge say which one new tabs will open
function paintAction(mode) {
  chrome.action.setBadgeText({ text: mode === 'chrome' ? 'off' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  chrome.action.setTitle({ title: mode === 'chrome' ? 'New tabs open Chrome’s page. Click (or Alt+Shift+T) to switch back to Tabboard.' : 'New tabs open Tabboard. Click (or Alt+Shift+T) to use Chrome’s new tab instead.' });
}
chrome.storage.local.get('ntmode').then(({ ntmode = 'tabboard' }) => paintAction(ntmode));
chrome.storage.onChanged.addListener((c) => { if (c.ntmode) paintAction(c.ntmode.newValue); });
