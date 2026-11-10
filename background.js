// Voice Reader — background: right-click menu + keyboard shortcuts.

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'vr-read', title: '🔊 Read aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'vr-page', title: '🔊 Read this page aloud', contexts: ['page'] });
  });
});

async function sendToTab(tabId, msg) {
  const opts = { frameId: 0 };
  try {
    return await chrome.tabs.sendMessage(tabId, msg, opts);
  } catch (e) {
    // Tab was open before the extension was installed/reloaded: inject now.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['voices.js', 'content.js'] });
      return await chrome.tabs.sendMessage(tabId, msg, opts);
    } catch (err) {
      console.warn('Voice Reader cannot run on this page:', err.message);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'vr-read') sendToTab(tab.id, { type: 'read', text: info.selectionText || '' });
  if (info.menuItemId === 'vr-page') sendToTab(tab.id, { type: 'readPage' });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || tab.id == null) return;
  const map = { 'read-selection': { type: 'read' }, 'toggle-pause': { type: 'toggle' }, 'stop-reading': { type: 'stop' } };
  if (map[command]) sendToTab(tab.id, map[command]);
});
