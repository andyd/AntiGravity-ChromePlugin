function getVisibleText() {
  const clone = document.body.cloneNode(true);
  
  // Remove noise
  const noiseSelectors = [
    'script', 'style', 'noscript', 'iframe', 'svg', 
    'nav', 'footer', 'header', 'aside', '.ad', '.ads', 
    '[role="alert"]', '[role="banner"]', '[role="navigation"]'
  ];
  
  noiseSelectors.forEach(selector => {
    const elements = clone.querySelectorAll(selector);
    elements.forEach(el => el.remove());
  });

  // Get text content and clean up whitespace
  let text = clone.innerText;
  text = text.replace(/\s+/g, ' ').trim();
  
  return text;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "GET_CONTENT") {
    const content = getVisibleText();
    sendResponse({
      url: window.location.href,
      title: document.title,
      content: content
    });
  }
  return true;
});
