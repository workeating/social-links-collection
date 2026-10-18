(() => {
  'use strict';
  const config = window.SOCIAL_LINKS_CONFIG;
  if (!config) return;
  let frame, frameOrigin = '', accessToken = sessionStorage.getItem('social-links-google-token') || '';
  const pending = new Map();
  const imageCache = new Map();
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

  function getFrame() {
    if (frame) return Promise.resolve(frame);
    return new Promise((resolve, reject) => {
      frame = document.createElement('iframe');
      frame.title = '資料同步服務';
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;bottom:0;border:0;opacity:0;pointer-events:none';
      frame.src = config.apiUrl;
      const timeout = setTimeout(() => reject(new Error('資料服務連線逾時')), 15000);
      const onReady = event => {
        const validOrigin = event.origin === new URL(config.apiUrl).origin || event.origin.endsWith('.googleusercontent.com');
        if (!validOrigin || event.source !== frame.contentWindow || event.data?.type !== 'SOCIAL_LINKS_BRIDGE_READY') return;
        frameOrigin = event.origin; clearTimeout(timeout); window.removeEventListener('message', onReady); resolve(frame);
      };
      window.addEventListener('message', onReady);
      document.body.append(frame);
    });
  }

  async function api(action, payload = {}) {
    await getFrame();
    const id = makeId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('資料服務回應逾時')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ type: 'SOCIAL_LINKS_API', id, action, accessToken, payload }, frameOrigin);
    });
  }

  window.addEventListener('message', event => {
    if (event.origin !== frameOrigin || event.source !== frame?.contentWindow || event.data?.type !== 'SOCIAL_LINKS_RESULT') return;
    const item = pending.get(event.data.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(event.data.id);
    if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data.result);
  });

  async function signIn() {
    if (!window.google?.accounts?.oauth2) throw new Error('Google 登入元件尚未載入');
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId,
        scope: 'openid email https://www.googleapis.com/auth/drive.file',
        callback: response => {
          if (response.error) { reject(new Error(response.error_description || response.error)); return; }
          accessToken = response.access_token;
          sessionStorage.setItem('social-links-google-token', accessToken);
          resolve(api('getConfig'));
        },
        error_callback: error => reject(new Error(error.message || 'Google 登入失敗'))
      });
      client.requestAccessToken();
    });
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('無法讀取圖片'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(file);
    });
  }

  async function uploadFile(file) {
    if (!accessToken) throw new Error('請先登入 Google');
    const base64 = await fileToBase64(file);
    return api('uploadImage', { name: file.name, mimeType: file.type, base64 });
  }

  async function readImage(id) {
    if (imageCache.has(id)) return imageCache.get(id);
    const data = await api('getImage', { id });
    const source = `data:${data.mimeType};base64,${data.base64}`;
    imageCache.set(id, source);
    return source;
  }

  async function resolveImage(source) {
    return String(source || '').startsWith('drive:') ? readImage(String(source).slice(6)) : source;
  }

  async function migrateImages(records) {
    const uploaded = new Map();
    for (const record of records) {
      const oldImages = Array.isArray(record.images) && record.images.length ? record.images : (record.image ? [record.image] : []);
      const newImages = [];
      for (const source of oldImages) {
        if (String(source).startsWith('drive:')) { newImages.push(source); continue; }
        if (uploaded.has(source)) { newImages.push(uploaded.get(source)); continue; }
        const response = await fetch(source);
        if (!response.ok) throw new Error(`無法讀取舊截圖：${source}`);
        const blob = await response.blob();
        const name = String(source).startsWith('data:') ? 'screenshot.jpg' : (String(source).split('/').pop().split('?')[0] || 'screenshot.jpg');
        const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
        const result = await uploadFile(file);
        const reference = `drive:${result.id}`;
        uploaded.set(source, reference); newImages.push(reference);
      }
      record.images = newImages; record.image = '';
    }
    return records;
  }

  async function pickImages() {
    if (!accessToken) throw new Error('請先登入 Google');
    if (!window.google?.picker) await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://apis.google.com/js/api.js';
      script.onload = () => gapi.load('picker', { callback: resolve }); script.onerror = () => reject(new Error('無法載入 Google Picker')); document.head.append(script);
    });
    return new Promise((resolve, reject) => {
      const view = new google.picker.DocsView(google.picker.ViewId.DOCS_IMAGES);
      view.setIncludeFolders(false);
      const picker = new google.picker.PickerBuilder()
        .setAppId(config.projectNumber)
        .setDeveloperKey(config.pickerKey)
        .setOAuthToken(accessToken)
        .setOrigin(window.location.origin)
        .addView(view)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setCallback(async data => {
          if (data.action === google.picker.Action.CANCEL) resolve([]);
          if (data.action !== google.picker.Action.PICKED) return;
          try {
            const picked = await Promise.all(data.docs.map(async doc => {
              const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(doc.id)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
              if (!response.ok) throw new Error(`讀取「${doc.name}」失敗`);
              const blob = await response.blob();
              const file = new File([blob], doc.name, { type: doc.mimeType || blob.type });
              return { file, originalId: doc.id, name: doc.name };
            }));
            resolve(picked);
          } catch (error) { reject(error); }
        }).build();
      picker.setVisible(true);
    });
  }

  window.SLCloud = { api, signIn, uploadFile, readImage, resolveImage, migrateImages, pickImages, get signedIn() { return !!accessToken; } };
})();
