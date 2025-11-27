
(async function logVisit() {
  try {
    await fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'VISIT',
        path: window.location.pathname
      })
    });
  } catch (err) {
    console.warn('Visit log failed', err);
  }
})();



document.addEventListener('click', function (e) {
  const link = e.target.closest('.btn-download');
  if (!link) return;

  const href = link.getAttribute('href') || '';
  let fileName = '';
  try {
    const urlPart = href.split('?')[0];      
    fileName = urlPart.split('/').pop() || '';
  } catch (_) {
    fileName = '';
  }


  try {
    fetch('/api/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'DOWNLOAD',
        path: window.location.pathname,
        fileName
      })
    });
  } catch (err) {
    console.warn('Download log failed', err);
  }
});
