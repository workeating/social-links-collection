(() => {
  'use strict';
  const localPreview = location.protocol === 'file:';
  const signInButton = document.getElementById('googleSignIn');
  const newButton = document.getElementById('new');
  if (localPreview || !window.SLCloud) return;
  let editor = false, bootstrapped = false, remoteMode = false;

  function applyRole(role) {
    editor = role === 'admin' || role === 'editor';
    if (newButton) newButton.disabled = !editor;
    document.querySelectorAll('[data-edit], .edit').forEach(button => button.hidden = !editor);
    if (signInButton) signInButton.textContent = SLCloud.signedIn ? 'Google 已登入' : '登入 Google';
  }

  async function loadCloud() {
    const config = await SLCloud.api('getConfig');
    applyRole(config.role);
    remoteMode = config.visibility !== 'public';
    const recordsOnServer = await SLCloud.api('listLinks');
    if (recordsOnServer.length) {
      records = recordsOnServer;
      localStorage.setItem('social-links-v1', JSON.stringify(records));
    } else if (config.role === 'admin' && !bootstrapped) {
      records = await SLCloud.migrateImages(records);
      await SLCloud.api('saveAll', { links: records });
      localStorage.setItem('social-links-v1', JSON.stringify(records));
      bootstrapped = true;
    } else if (remoteMode) {
      records = [];
      localStorage.setItem('social-links-v1', '[]');
    }
    window.render();
  }

  window.save = async function () {
    if (editor) {
      try {
        records = await SLCloud.migrateImages(records);
      } catch (error) {
        alert('圖片無法存入私人 Drive：' + error.message);
        return;
      }
    }
    localStorage.setItem('social-links-v1', JSON.stringify(records));
    render();
    if (remoteMode && !editor) return;
    if (editor) SLCloud.api('saveAll', { links: records }).catch(error => alert('雲端儲存失敗：' + error.message));
  };

  document.addEventListener('click', async event => {
    if (event.target.closest('#googleSignIn')) {
      try { await SLCloud.signIn(); await loadCloud(); }
      catch (error) { alert('Google 登入或同步失敗：' + error.message); }
    }
  });

  function hydrateDriveImages(root = document) {
    const images = [];
    if (root.matches?.('[data-drive-id]')) images.push(root);
    images.push(...(root.querySelectorAll?.('[data-drive-id]') || []));
    images.forEach(async image => {
      if (image.dataset.imageReady) return;
      image.dataset.imageReady = '1';
      try { image.src = await SLCloud.readImage(image.dataset.driveId); }
      catch { image.alt = '圖片目前無法載入'; }
    });
  }
  hydrateDriveImages();
  new MutationObserver(changes => changes.forEach(change => change.addedNodes.forEach(node => {
    if (node.nodeType === Node.ELEMENT_NODE) hydrateDriveImages(node);
  }))).observe(document.body, { childList: true, subtree: true });

  applyRole('');
  loadCloud().catch(error => {
    if (remoteMode) { records = []; localStorage.setItem('social-links-v1', '[]'); render(); }
    applyRole('');
    console.warn('Cloud sync unavailable:', error.message);
  });
})();
