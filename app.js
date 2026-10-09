/* Gomaa Scan. All processing and document storage stay on this device. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const CDN = {
    cv: 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.12.0-release.1/dist/opencv.js',
    pdf: 'https://cdn.jsdelivr.net/npm/jspdf@4.2.1/dist/jspdf.umd.min.js',
    ocr: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js',
    worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js',
    core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
    lang: 'https://tessdata.projectnaptha.com/4.0.0'
  };
  const state = {
    lang: 'ar', theme: 'system', view: 'library', records: [], selected: new Set(),
    selecting: false, doc: null, dirty: false, pageIndex: 0, queue: [],
    source: null, warped: null, corners: [], filter: 'original', rotation: 0,
    stream: null, cameraToken: 0, detectionTimer: 0, lastCorners: null, stableAnchor: null,
    stableSince: 0, capturing: false, torch: false, busy: false,
    ocrWorker: null, ocrRun: 0, installEvent: null, objectUrls: new Set(),
    db: null, cv: null, cvPromise: null, sw: null, offlineRunning: false
  };
  const EN = {
    skipToContent:'Skip to content',offline:'Offline',toggleTheme:'Switch appearance',
    installTitle:'Gomaa Scan on your home screen',installDescription:'Install the app to open it directly from your home screen.',
    install:'Install',later:'Later',library:'Library',select:'Select',searchDocuments:'Search documents',
    searchPlaceholder:'Search by document name',sort:'Sort',newest:'Newest first',oldest:'Oldest first',byName:'By name',
    viewMode:'View mode',gridView:'Grid view',listView:'List view',selectAll:'Select all',share:'Share',
    delete:'Delete',cancel:'Cancel',documents:'Documents',emptyTitle:'Your first scan starts here',
    emptyDescription:'Scan a document or choose images from your gallery.',newScan:'New scan',importGallery:'From gallery',
    noResults:'No documents match this name.',scan:'Scan a document',close:'Close',cameraPreview:'Camera preview',
    cameraStarting:'Starting camera…',autoCapture:'Capture automatically when edges are stable',flash:'Flash',
    gallery:'Gallery',capture:'Capture photo',retryCamera:'Try camera again',cameraHint:'Place the paper on a contrasting background with good lighting.',
    adjustEdges:'Adjust edges',cropHint:'Drag the four corners. You can also focus a corner and move it with the arrow keys.',
    originalImage:'Original image',cornerTopLeft:'Top left corner',cornerTopRight:'Top right corner',
    cornerBottomRight:'Bottom right corner',cornerBottomLeft:'Bottom left corner',useFullImage:'Use full image',
    confirmCrop:'Crop and correct perspective',enhanceImage:'Enhance image',editedPreview:'Edited image preview',
    imageFilters:'Image filters',filterOriginal:'Original',filterMagic:'Magic Color',filterBW:'Black & White',
    filterGray:'Grayscale',filterLighten:'Lighten',filterShadows:'Remove Shadows',brightness:'Brightness',
    contrast:'Contrast',rotate90:'Rotate 90°',reset:'Reset',keepPage:'Keep page',backLibrary:'Library',
    addPages:'Add pages',saveDocument:'Save document',saveChanges:'Save changes',download:'Download',rename:'Rename',
    extractText:'Extract text',reorderHint:'Drag a page handle to reorder, or use the Move earlier and Move later buttons.',
    settings:'Settings',language:'Language',appearance:'Appearance',followSystem:'Follow system',lightMode:'Light',darkMode:'Dark',
    localStorage:'Device storage',requestPersistence:'Request persistent storage',
    storageHint:'Your browser decides whether to grant persistent storage. Download backups of important documents.',
    offlinePreparation:'Prepare for offline use',offlineHint:'Download scanning and PDF libraries, plus Arabic and English OCR data, while online.',
    offlineNotReady:'Download is not complete yet.',offlineProgress:'Offline download progress',prepareOffline:'Download offline files',
    installApplication:'Install the app',installHelp:'Android: browser menu, then Install app. iPhone: open in Safari, then Share, then Add to Home Screen.',
    privacyNote:'Your images and documents are processed and saved on this device. They are not uploaded to a server.',
    mainNavigation:'Main navigation',scanTab:'Scan',fileName:'File name',uniqueNameHint:'A number is added automatically if the name is already used.',
    format:'Format',jpgHint:'For multiple pages, each page downloads and shares as a separate JPG image.',
    compressionQuality:'Compression quality',qualityHigh:'High — clearer, larger files',qualityMedium:'Medium — balanced size',
    qualitySmall:'Small — smallest files',save:'Save',confirmDeletion:'Confirm deletion',textLanguage:'Text language',
    arabicEnglish:'Arabic and English',arabic:'Arabic',english:'English',pages:'Pages',allPages:'All pages',currentPage:'Selected page',
    ocrHint:'Review the extracted text before copying; accuracy depends on image clarity.',ocrProgress:'Text extraction progress',
    extractedText:'Extracted text',startOCR:'Extract text',stop:'Stop',copyText:'Copy text',pagePreview:'Page preview',
    documentPage:'Document page',previousPage:'Previous',nextPage:'Next',selectDocument:'Select document',
    dragPage:'Drag to reorder page',moveBefore:'Move earlier',moveAfter:'Move later',processing:'Processing…',processingProgress:'Processing progress'
  };
  const AR = {};
  const messages = {
    count:['{n} مستند · محفوظ على جهازك','{n} documents · saved on this device'],
    pageCount:['{n} صفحة','{n} pages'],pageNumber:['صفحة {n}','Page {n}'],selectedCount:['تم تحديد {n}','{n} selected'],
    ready:['الحواف جاهزة — ثبّت الهاتف','Edges ready — hold steady'],findEdges:['وجّه الكاميرا نحو الورقة','Point the camera at the paper'],
    manual:['لم تُكتشف حواف واضحة. عدّل الزوايا يدويًا أو حدد الصورة كاملة.','No clear edges found. Adjust the corners manually or use the full image.'],
    found:['تم اكتشاف الحواف. راجع الزوايا قبل القص.','Edges found. Check the corners before cropping.'],
    cameraDenied:['الكاميرا مرفوضة. اسمح بها من إعدادات المتصفح، أو اختر صورة من المعرض لتعديلها يدويًا.','Camera access denied. Allow it in browser settings, or import a gallery image for manual adjustment.'],
    cameraMissing:['الكاميرا غير متاحة. اختر صورًا من المعرض.','Camera unavailable. Choose images from your gallery.'],
    cameraSecure:['الكاميرا تحتاج HTTPS أو localhost. يمكنك اختيار صور من المعرض.','Camera requires HTTPS or localhost. You can import gallery images.'],
    cameraPaused:['الكاميرا متوقفة. اضغط إعادة المحاولة.','Camera paused. Tap Try camera again.'],
    loadCV:['جارٍ تحميل محرّك معالجة الصور…','Loading image processing engine…'],
    loadFailed:['تعذر تحميل المكتبة. اتصل بالإنترنت وأعد المحاولة.','Library download failed. Connect to the internet and try again.'],
    error:['حدث خطأ. حاول مرة أخرى.','Something went wrong. Please try again.'],
    invalidImage:['الصورة غير مدعومة أو تالفة. جرّب JPG أو PNG.','Unsupported or damaged image. Try JPG or PNG.'],
    invalidCorners:['الزوايا متقاطعة أو المساحة صغيرة جدًا. عدّلها قبل القص.','Corners overlap or the area is too small. Adjust them before cropping.'],
    saved:['تم حفظ المستند','Document saved'],changesSaved:['تم حفظ التغييرات','Changes saved'],renamed:['تم تغيير الاسم','Document renamed'],
    removed:['تم الحذف','Deleted'],discardTitle:['تجاهل التغييرات؟','Discard changes?'],
    discard:['عند الخروج ستفقد الصفحات والتغييرات غير المحفوظة.','Leaving will discard unsaved pages and changes.'],
    discardAction:['تجاهل','Discard'],deleteDocs:['حذف {n} مستند من هذا الجهاز؟ لا يمكن التراجع.','Delete {n} documents from this device? This cannot be undone.'],
    deletePage:['حذف هذه الصفحة من المستند؟','Delete this page from the document?'],
    lastPage:['لا يمكن حذف آخر صفحة. يمكنك حذف المستند من المكتبة.','The last page cannot be removed. Delete the document from the library instead.'],
    draft:['مستند جديد','New document'],unsaved:['تغييرات غير محفوظة','Unsaved changes'],emptyName:['اكتب اسمًا صالحًا للملف.','Enter a valid file name.'],
    dbError:['تعذر فتح التخزين المحلي. جرّب الوضع العادي للمتصفح واسمح بتخزين بيانات الموقع.','Local storage unavailable. Use a normal browser window and allow site storage.'],
    quota:['المساحة غير كافية. حمّل نسخة احتياطية، ثم احذف بعض المستندات أو اختر جودة أقل.','Not enough storage. Download backups, then remove documents or choose a lower quality.'],
    downloading:['تم بدء التحميل. قد يطلب المتصفح السماح بتحميل عدة ملفات.','Download started. Your browser may ask to allow multiple files.'],
    shareReady:['الملفات جاهزة. اضغط مشاركة مرة أخرى لفتح خيارات المشاركة.','Files are ready. Tap Share again to open sharing options.'],
    shareFallback:['مشاركة الملفات غير مدعومة هنا. تم بدء تحميلها.','File sharing is unavailable here. Downloads have started.'],
    copied:['تم نسخ النص','Text copied'],copyManual:['حدد النص وانسخه يدويًا.','Select the text and copy it manually.'],
    ocrLoading:['جارٍ تحميل بيانات التعرف على النص…','Loading OCR data…'],ocrPage:['استخراج صفحة {n} من {total}','Reading page {n} of {total}'],
    ocrDone:['تم استخراج النص. راجعه قبل النسخ.','Text extracted. Review before copying.'],ocrStopped:['تم إيقاف استخراج النص','Text extraction stopped'],
    persistent:['التخزين الدائم مفعّل','Persistent storage is enabled'],notPersistent:['التخزين الدائم غير مفعّل','Persistent storage is not enabled'],
    storageUnsupported:['هذا المتصفح لا يوفّر طلب التخزين الدائم.','This browser does not offer persistent storage requests.'],
    usage:['المستخدم: {used} · المساحة التقريبية: {total}','Used: {used} · Approximate quota: {total}'],
    offlineReady:['اكتمل التجهيز: المسح وPDF وOCR متاحة دون إنترنت.','Ready: scanning, PDF and OCR are available offline.'],
    offlinePartial:['الملفات المحفوظة: {n} من {total}','Cached files: {n} of {total}'],
    offlineNeedOnline:['اتصل بالإنترنت لإكمال تنزيل ملفات الأوفلاين.','Connect to the internet to finish downloading offline files.'],
    swUnavailable:['العمل أوفلاين يحتاج متصفحًا يدعم Service Worker وHTTPS.','Offline use requires Service Worker support and HTTPS.'],
    batch:['الصور المتبقية: {n}','Remaining images: {n}'],memory:['تعذر معالجة الصورة. جرّب صورة أصغر أو أغلق التطبيقات الأخرى.','Image processing failed. Try a smaller image or close other apps.']
  };
  function t(key, vars = {}) {
    let text = messages[key]?.[state.lang === 'ar' ? 0 : 1] ?? (state.lang === 'ar' ? AR[key] : EN[key]) ?? AR[key] ?? key;
    for (const [name,value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }
  function seedTranslations(root) {
    for (const el of $$('[data-i18n]', root)) AR[el.dataset.i18n] ??= el.textContent;
    for (const [attr,data] of [['aria-label','i18nAria'],['placeholder','i18nPlaceholder'],['alt','i18nAlt']]) {
      for (const el of $$(`[data-${data.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}]`,root)) AR[el.dataset[data]] ??= el.getAttribute(attr);
    }
  }
  function translate(root = document) {
    $$('[data-i18n]',root).forEach(el => el.textContent = t(el.dataset.i18n));
    for (const [attr,data] of [['aria-label','i18nAria'],['placeholder','i18nPlaceholder'],['alt','i18nAlt']]) {
      for (const el of $$(`[data-${data.replace(/[A-Z]/g,m=>'-'+m.toLowerCase())}]`,root)) el.setAttribute(attr,t(el.dataset[data]));
    }
  }
  function pref(key,value) { try { if (value !== undefined) localStorage.setItem('gomaa-'+key,value); return localStorage.getItem('gomaa-'+key); } catch { return null; } }
  function applyLanguage(value) {
    state.lang = value === 'en' ? 'en' : 'ar'; pref('lang',state.lang);
    document.documentElement.lang = state.lang; document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
    $('languageSelect').value = state.lang; translate(); renderLibrary(); if (state.doc) renderDocument(); refreshStorage(); checkOffline();
  }
  function applyTheme(value) {
    state.theme = ['light','dark'].includes(value) ? value : 'system'; pref('theme',state.theme);
    document.documentElement.dataset.theme = state.theme; $('themeSelect').value = state.theme;
    $('themeColor').content = (state.theme === 'dark' || (state.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)) ? '#0d1626' : '#2563eb';
  }
  function toast(text, error = false) {
    const el = $(error ? 'alertToast' : 'toast'); el.textContent = text; el.classList.add('visible');
    clearTimeout(el._timer); el._timer = setTimeout(() => el.classList.remove('visible'),5000);
  }
  function errorMessage(error) { return error?.name === 'QuotaExceededError' ? t('quota') : error?.userMessage || t('error'); }
  function userError(key) { const error = new Error(key); error.userMessage = t(key); return error; }
  const safe = fn => async (...args) => { try { await fn(...args); } catch (error) { console.error(error); toast(errorMessage(error),true); } };
  const nextPaint = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve,0)));
  async function busy(fn, text = t('processing')) {
    if (state.busy) return; state.busy = true; $('busyMessage').textContent = text; $('busyOverlay').hidden = false;
    document.querySelector('.app-shell').inert = true;
    try { await nextPaint(); return await fn(); }
    finally { state.busy = false; $('busyOverlay').hidden = true; document.querySelector('.app-shell').inert = false; }
  }
  function view(name) {
    if (name !== 'scan') stopCamera(); state.view = name;
    for (const el of $$('.view')) el.hidden = el.id !== name+'View';
    for (const button of $$('[data-nav]')) { const active = button.dataset.nav === name; button.classList.toggle('active',active); if(active) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current'); }
    $('newScanFab').hidden = name !== 'library';
    const heading = $(name+'View')?.querySelector('h1'); if (heading) { heading.tabIndex = -1; heading.focus({preventScroll:true}); }
    window.scrollTo({top:0,behavior:'instant'});
  }
  function confirm(message,title=t('confirmDeletion'),action=t('delete')) {
    return new Promise(resolve => {
      $('confirmTitle').textContent=title; $('confirmMessage').textContent=message; $('confirmActionButton').textContent=action;
      const dialog=$('confirmDialog'); dialog.returnValue='cancel'; dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm'),{once:true}); dialog.showModal();
    });
  }
  async function leaveCurrent() {
    if ((state.dirty || state.queue.length || ['crop','edit'].includes(state.view)) && !await confirm(t('discard'),t('discardTitle'),t('discardAction'))) return false;
    state.doc=null; state.dirty=false; state.queue=[]; state.source=null; state.warped=null; return true;
  }
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
  function defaultName() { const d=new Date(),pad=n=>String(n).padStart(2,'0'); return `GomaaScan_${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`; }
  function cleanName(name) { return name.normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'').replace(/\.(pdf|jpe?g)$/i,'').trim().slice(0,120); }
  function openDatabase() {
    return new Promise((resolve,reject) => {
      const req=indexedDB.open('GomaaScan',1);
      req.onupgradeneeded=()=>{const store=req.result.createObjectStore('documents',{keyPath:'id'});store.createIndex('nameKey','nameKey',{unique:true});};
      req.onsuccess=()=>{state.db=req.result;state.db.onversionchange=()=>state.db.close();resolve();}; req.onerror=()=>reject(userError('dbError'));
      req.onblocked=()=>toast(t('dbError'),true);
    });
  }
  function dbRead() { return new Promise((resolve,reject)=>{const tx=state.db.transaction('documents');const req=tx.objectStore('documents').getAll();req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);}); }
  function dbSave(record,desiredName) {
    const name=cleanName(desiredName); if(!name) return Promise.reject(userError('emptyName'));
    return new Promise((resolve,reject)=>{
      const tx=state.db.transaction('documents','readwrite'),store=tx.objectStore('documents'),req=store.getAll();let saved;
      req.onsuccess=()=>{
        const used=new Set(req.result.filter(x=>x.id!==record.id).map(x=>x.nameKey));let candidate=name,n=2;
        while(used.has(candidate.toLocaleLowerCase())) candidate=name.slice(0,110)+` (${n++})`;
        saved={...record,id:record.id||uid(),name:candidate,nameKey:candidate.toLocaleLowerCase(),updatedAt:Date.now(),createdAt:record.createdAt||Date.now()};store.put(saved);
      };
      tx.oncomplete=()=>resolve(saved);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||userError('error'));
    });
  }
  function dbDelete(ids) { return new Promise((resolve,reject)=>{const tx=state.db.transaction('documents','readwrite');ids.forEach(id=>tx.objectStore('documents').delete(id));tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
  async function refreshLibrary() { state.records=await dbRead();renderLibrary(); }
  function releaseUrls() {state.objectUrls.forEach(url=>URL.revokeObjectURL(url));state.objectUrls.clear();}
  function blobUrl(blob) {const url=URL.createObjectURL(blob);state.objectUrls.add(url);return url;}
  function renderLibrary() {
    if(state.view==='library') releaseUrls(); const grid=$('documentGrid');grid.replaceChildren();
    const query=$('searchInput').value.trim().toLocaleLowerCase(),sort=$('sortSelect').value;
    const list=state.records.filter(d=>d.name.toLocaleLowerCase().includes(query)).sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,state.lang):sort==='oldest'?a.createdAt-b.createdAt:b.createdAt-a.createdAt);
    $('librarySummary').textContent=t('count',{n:state.records.length});$('emptyLibrary').hidden=state.records.length!==0;
    $('noSearchResults').hidden=state.records.length===0||list.length!==0;
    $('selectionToolbar').hidden=!state.selecting;$('selectionCount').textContent=t('selectedCount',{n:state.selected.size});
    $('selectModeButton').setAttribute('aria-pressed',String(state.selecting));$('shareSelectedButton').disabled=$('deleteSelectedButton').disabled=!state.selected.size;
    for(const doc of list){
      const card=$('documentCardTemplate').content.firstElementChild.cloneNode(true);translate(card);card.dataset.id=doc.id;
      card.classList.toggle('selected',state.selected.has(doc.id));card.querySelector('.document-name').textContent=doc.name;
      card.querySelector('.document-details').textContent=`${t('pageCount',{n:doc.pages.length})} · ${new Date(doc.createdAt).toLocaleDateString(state.lang)} · ${doc.format.toUpperCase()}`;
      card.querySelector('.document-cover').src=blobUrl(doc.thumbnail||doc.pages[0].blob);
      const checkbox=card.querySelector('.document-checkbox');checkbox.checked=state.selected.has(doc.id);checkbox.setAttribute('aria-label',t('selectDocument')+': '+doc.name);
      card.querySelector('.document-selection').hidden=!state.selecting;
      checkbox.addEventListener('change',()=>toggleSelection(doc.id));
      card.querySelector('.document-open').onclick=safe(async()=>{if(state.selecting)toggleSelection(doc.id);else await openDocument(doc.id);});
      card.querySelector('.card-share').onclick=safe(()=>shareDocs([doc]));card.querySelector('.card-download').onclick=safe(()=>downloadDocs([doc]));
      card.querySelector('.card-rename').onclick=()=>openRename(doc);card.querySelector('.card-delete').onclick=safe(()=>deleteDocs([doc.id]));
      grid.append(card);
    }
  }
  function toggleSelection(id) {if(state.selected.has(id))state.selected.delete(id);else state.selected.add(id);renderLibrary();}
  function canvas(width,height) {const el=document.createElement('canvas');el.width=width;el.height=height;return el;}
  function canvasBlob(el,quality=.92) {return new Promise((resolve,reject)=>el.toBlob(blob=>blob?resolve(blob):reject(userError('memory')),'image/jpeg',quality));}
  async function decodeImage(blob,max=2400) {
    const url=URL.createObjectURL(blob);
    try {const img=new Image();img.src=url;await img.decode();const scale=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));const el=canvas(Math.max(1,Math.round(img.naturalWidth*scale)),Math.max(1,Math.round(img.naturalHeight*scale)));const ctx=el.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,el.width,el.height);ctx.drawImage(img,0,0,el.width,el.height);return el;}
    catch {throw userError('invalidImage');}finally{URL.revokeObjectURL(url);}
  }
  const scripts=new Map();
  function loadScript(url) {
    if(scripts.has(url))return scripts.get(url);
    const promise=new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=url;el.crossOrigin='anonymous';const timer=setTimeout(()=>{el.remove();scripts.delete(url);reject(userError('loadFailed'));},90000);el.onload=()=>{clearTimeout(timer);resolve();};el.onerror=()=>{clearTimeout(timer);el.remove();scripts.delete(url);reject(userError('loadFailed'));};document.head.append(el);});scripts.set(url,promise);return promise;
  }
  function ensureCV() {
    if(state.cv)return Promise.resolve(state.cv);if(state.cvPromise)return state.cvPromise;
    state.cvPromise=(async()=>{
      await loadScript(CDN.cv);let cv=window.cv;
      if(Object.prototype.toString.call(cv)==='[object Promise]')cv=await cv;
      if(!cv?.Mat)await new Promise((resolve,reject)=>{
        const started=Date.now();const timer=setInterval(()=>{
          if(cv?.Mat){clearInterval(timer);resolve();}
          else if(Date.now()-started>90000){clearInterval(timer);reject(userError('loadFailed'));}
        },50);
      });
      // This pinned Emscripten build has a self-returning .then method, not a Promise.
      // Remove it after initialization so async return does not recurse indefinitely.
      if(typeof cv.then==='function')delete cv.then;
      if(!cv?.Mat)throw userError('loadFailed');state.cv=cv;return cv;
    })().catch(error=>{state.cvPromise=null;scripts.delete(CDN.cv);throw error;});return state.cvPromise;
  }
  async function ensurePDF(){if(!window.jspdf)await loadScript(CDN.pdf);return window.jspdf.jsPDF;}
  async function ensureOCR(){if(!window.Tesseract)await loadScript(CDN.ocr);return window.Tesseract;}
  function orderPoints(points) {
    const cx=points.reduce((n,p)=>n+p.x,0)/4,cy=points.reduce((n,p)=>n+p.y,0)/4;
    const sorted=[...points].sort((a,b)=>Math.atan2(a.y-cy,a.x-cx)-Math.atan2(b.y-cy,b.x-cx));
    const start=sorted.reduce((best,p,i)=>p.x+p.y<sorted[best].x+sorted[best].y?i:best,0);return [...sorted.slice(start),...sorted.slice(0,start)];
  }
  function detectCorners(input) {
    const cv=state.cv;if(!cv)return null;const mats=[];const keep=m=>{mats.push(m);return m;};
    try {
      const src=keep(cv.imread(input)),gray=keep(new cv.Mat()),blur=keep(new cv.Mat()),edges=keep(new cv.Mat()),hierarchy=keep(new cv.Mat()),contours=keep(new cv.MatVector());
      cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);cv.GaussianBlur(gray,blur,new cv.Size(5,5),0);cv.Canny(blur,edges,45,135);
      const kernel=keep(cv.Mat.ones(3,3,cv.CV_8U));cv.morphologyEx(edges,edges,cv.MORPH_CLOSE,kernel);
      cv.findContours(edges,contours,hierarchy,cv.RETR_EXTERNAL,cv.CHAIN_APPROX_SIMPLE);
      let best=null,bestArea=0;const total=input.width*input.height;
      for(let i=0;i<contours.size();i++){
        const contour=contours.get(i),approx=new cv.Mat();
        try {const area=Math.abs(cv.contourArea(contour));if(area<total*.16||area>total*.995||area<bestArea)continue;
          cv.approxPolyDP(contour,approx,cv.arcLength(contour,true)*.025,true);
          if(approx.rows===4&&cv.isContourConvex(approx)){const pts=[];for(let j=0;j<4;j++)pts.push({x:approx.data32S[j*2]/input.width,y:approx.data32S[j*2+1]/input.height});best=orderPoints(pts);bestArea=area;}
        }finally{contour.delete();approx.delete();}
      }return best;
    }finally{mats.reverse().forEach(m=>m.delete());}
  }
  function stopCamera() {
    state.cameraToken++;clearTimeout(state.detectionTimer);state.stream?.getTracks().forEach(track=>track.stop());
    state.stream=null;state.torch=false;state.lastCorners=null;state.stableAnchor=null;state.stableSince=0;$('cameraVideo').srcObject=null;$('torchButton').hidden=true;$('captureButton').disabled=true;
  }
  async function startCamera() {
    stopCamera();const token=state.cameraToken;$('cameraError').hidden=true;$('retryCameraButton').hidden=true;$('cameraStatus').textContent=t('cameraStarting');
    try {
      if(!window.isSecureContext)throw userError('cameraSecure');if(!navigator.mediaDevices?.getUserMedia)throw userError('cameraMissing');
      const stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}}});
      if(token!==state.cameraToken||state.view!=='scan'){stream.getTracks().forEach(track=>track.stop());return;}
      state.stream=stream;const video=$('cameraVideo');video.srcObject=stream;await video.play();
      if(token!==state.cameraToken)return;$('captureButton').disabled=false;
      const track=stream.getVideoTracks()[0];$('torchButton').hidden=!track.getCapabilities?.().torch;$('torchButton').setAttribute('aria-pressed','false');
      $('cameraStatus').textContent=t('loadCV');ensureCV().then(()=>{if(token===state.cameraToken)analyzeFrame(token);}).catch(()=>{if(token===state.cameraToken)$('cameraStatus').textContent=t('manual');});
    }catch(error){
      if(token!==state.cameraToken)return;stopCamera();$('cameraError').textContent=error.userMessage||(error.name==='NotAllowedError'?t('cameraDenied'):t('cameraMissing'));
      $('cameraError').hidden=false;$('retryCameraButton').hidden=false;$('cameraStatus').textContent=t('cameraMissing');
    }
  }
  function analyzeFrame(token) {
    if(token!==state.cameraToken||state.view!=='scan'||!state.stream)return;
    const video=$('cameraVideo'),sample=$('detectionCanvas');
    try {
      if(video.readyState>=2){
        const scale=420/Math.max(video.videoWidth,video.videoHeight);sample.width=Math.round(video.videoWidth*scale);sample.height=Math.round(video.videoHeight*scale);
        sample.getContext('2d',{willReadFrequently:true}).drawImage(video,0,0,sample.width,sample.height);
        const corners=detectCorners(sample);drawCameraCorners(corners);
        if(corners){
          const stable=state.stableAnchor&&corners.every((p,i)=>Math.hypot(p.x-state.stableAnchor[i].x,p.y-state.stableAnchor[i].y)<.022);
          if(!stable){state.stableSince=performance.now();state.stableAnchor=corners.map(p=>({...p}));}state.lastCorners=corners;$('cameraStatus').textContent=t('ready');
          if($('autoCaptureToggle').checked&&performance.now()-state.stableSince>=1000&&!state.capturing){safe(captureImage)();return;}
        }else{state.lastCorners=null;state.stableAnchor=null;state.stableSince=0;$('cameraStatus').textContent=t('findEdges');}
      }
    }catch{state.lastCorners=null;state.stableAnchor=null;state.stableSince=0;$('cameraStatus').textContent=t('manual');}
    state.detectionTimer=setTimeout(()=>analyzeFrame(token),280);
  }
  function drawCameraCorners(corners) {
    const overlay=$('cameraOverlay'),rect=$('cameraStage').getBoundingClientRect(),video=$('cameraVideo');
    overlay.width=Math.round(rect.width*devicePixelRatio);overlay.height=Math.round(rect.height*devicePixelRatio);const ctx=overlay.getContext('2d');ctx.scale(devicePixelRatio,devicePixelRatio);
    if(!corners)return;const scale=Math.min(rect.width/video.videoWidth,rect.height/video.videoHeight),w=video.videoWidth*scale,h=video.videoHeight*scale,x=(rect.width-w)/2,y=(rect.height-h)/2;
    ctx.beginPath();corners.forEach((p,i)=>i?ctx.lineTo(x+p.x*w,y+p.y*h):ctx.moveTo(x+p.x*w,y+p.y*h));ctx.closePath();ctx.strokeStyle='#55dbbc';ctx.fillStyle='#55dbbc22';ctx.lineWidth=3;ctx.fill();ctx.stroke();
  }
  async function captureImage() {
    if(state.capturing||state.busy||!state.stream)return;state.capturing=true;
    try {const video=$('cameraVideo');if(!video.videoWidth)return;const scale=Math.min(1,2400/Math.max(video.videoWidth,video.videoHeight));const image=canvas(Math.round(video.videoWidth*scale),Math.round(video.videoHeight*scale));image.getContext('2d').drawImage(video,0,0,image.width,image.height);const detected=state.lastCorners?.map(p=>({...p}));stopCamera();await busy(()=>beginImage(image,detected),t('loadCV'));}
    finally{state.capturing=false;}
  }
  async function beginImage(source,detected) {
    state.source=source;state.warped=null;
    try {await ensureCV();if(!detected){const scale=Math.min(1,800/Math.max(source.width,source.height)),sample=canvas(Math.round(source.width*scale),Math.round(source.height*scale));sample.getContext('2d').drawImage(source,0,0,sample.width,sample.height);detected=detectCorners(sample);}}
    catch(error){toast(errorMessage(error),true);}
    state.corners=detected||[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
    const target=$('cropCanvas');target.width=source.width;target.height=source.height;target.getContext('2d').drawImage(source,0,0);
    $('cropMessage').textContent=t(detected?'found':'manual')+(state.queue.length?' · '+t('batch',{n:state.queue.length}):'');
    view('crop');updateCorners();
  }
  async function importImages() {
    const files=[...$('imageInput').files];$('imageInput').value='';if(!files.length)return;
    if(['crop','edit'].includes(state.view)&&!await confirm(t('discard'),t('discardTitle'),t('discardAction')))return;
    state.doc??={id:null,name:t('draft'),pages:[],format:'pdf',quality:'medium'};state.queue=files.slice(1);stopCamera();
    await busy(async()=>beginImage(await decodeImage(files[0])));
  }
  function updateCorners() {
    const coords=state.corners.map(p=>`${p.x*1000},${p.y*1000}`);$('cropPolygon').setAttribute('points',coords.join(' '));
    $('cropShade').setAttribute('d','M0 0H1000V1000H0Z M'+coords.join(' L')+'Z');
    $$('.crop-handle').forEach((button,i)=>{button.style.left=(state.corners[i].x*100)+'%';button.style.top=(state.corners[i].y*100)+'%';});
  }
  function moveCorner(index,x,y) {state.corners[index]={x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))};updateCorners();}
  function showMagnifier(point,x,y) {
    const el=$('magnifierCanvas'),ctx=el.getContext('2d'),source=state.source,span=90;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,160,160);ctx.drawImage(source,point.x*source.width-span/2,point.y*source.height-span/2,span,span,0,0,160,160);
    ctx.strokeStyle='#2563eb';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(80,62);ctx.lineTo(80,98);ctx.moveTo(62,80);ctx.lineTo(98,80);ctx.stroke();
    el.style.left=Math.min(innerWidth-132,Math.max(8,x-62))+'px';el.style.top=Math.max(8,y-155)+'px';el.hidden=false;
  }
  function bindCropHandles() {
    for(const button of $$('.crop-handle')){
      const index=Number(button.dataset.corner);let dragging=false;
      const move=event=>{if(!dragging)return;event.preventDefault();const rect=$('cropCanvas').getBoundingClientRect();moveCorner(index,(event.clientX-rect.left)/rect.width,(event.clientY-rect.top)/rect.height);showMagnifier(state.corners[index],event.clientX,event.clientY);};
      button.addEventListener('pointerdown',event=>{dragging=true;button.setPointerCapture(event.pointerId);move(event);});button.addEventListener('pointermove',move);
      const finish=()=>{dragging=false;$('magnifierCanvas').hidden=true;};button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',finish);button.addEventListener('lostpointercapture',finish);
      button.addEventListener('keydown',event=>{const step=event.shiftKey?.02:.003,p=state.corners[index];if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();moveCorner(index,p.x+(event.key==='ArrowRight'?step:event.key==='ArrowLeft'?-step:0),p.y+(event.key==='ArrowDown'?step:event.key==='ArrowUp'?-step:0));}});
    }
  }
  function validCorners(points) {
    let area=0,sign=0;
    for(let i=0;i<4;i++){const a=points[i],b=points[(i+1)%4],c=points[(i+2)%4],cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);if(Math.abs(cross)<.0001)return false;if(sign&&Math.sign(cross)!==sign)return false;sign=Math.sign(cross);area+=a.x*b.y-b.x*a.y;}
    return sign>0&&area/2>.015;
  }
  async function cropImage() {
    if(!validCorners(state.corners))throw userError('invalidCorners');
    await busy(async()=>{
      const cv=await ensureCV(),source=state.source,pts=state.corners.map(p=>({x:p.x*(source.width-1),y:p.y*(source.height-1)}));
      const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);let w=Math.max(distance(pts[0],pts[1]),distance(pts[3],pts[2])),h=Math.max(distance(pts[0],pts[3]),distance(pts[1],pts[2]));
      const scale=Math.min(1,2400/Math.max(w,h));w=Math.max(2,Math.round(w*scale));h=Math.max(2,Math.round(h*scale));
      let src,dst,from,to,transform;
      try {src=cv.imread(source);dst=new cv.Mat();from=cv.matFromArray(4,1,cv.CV_32FC2,pts.flatMap(p=>[p.x,p.y]));to=cv.matFromArray(4,1,cv.CV_32FC2,[0,0,w-1,0,w-1,h-1,0,h-1]);transform=cv.getPerspectiveTransform(from,to);cv.warpPerspective(src,dst,transform,new cv.Size(w,h),cv.INTER_LINEAR,cv.BORDER_REPLICATE);state.warped=canvas(w,h);cv.imshow(state.warped,dst);}
      finally{[transform,to,from,dst,src].forEach(m=>m?.delete());}
      state.filter='original';state.rotation=0;$('brightnessRange').value=$('contrastRange').value=0;view('edit');await renderFilterThumbnails();renderEdited();
    });
  }
  function filteredCanvas(source,filter) {
    const cv=state.cv,output=canvas(source.width,source.height);if(filter==='original'){output.getContext('2d').drawImage(source,0,0);return output;}
    const mats=[],keep=m=>{mats.push(m);return m;};
    try {
      const src=keep(cv.imread(source)),gray=keep(new cv.Mat()),result=keep(new cv.Mat());
      if(filter==='gray'||filter==='bw'){
        cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);
        if(filter==='bw'){cv.GaussianBlur(gray,gray,new cv.Size(3,3),0);cv.adaptiveThreshold(gray,result,255,cv.ADAPTIVE_THRESH_GAUSSIAN_C,cv.THRESH_BINARY,31,11);}else gray.copyTo(result);
      }else if(filter==='lighten'){src.convertTo(result,-1,1.08,22);}
      else if(filter==='magic'){
        src.convertTo(result,-1,1.18,-15);
        const data=result.data;for(let i=0;i<data.length;i+=4){const mean=(data[i]+data[i+1]+data[i+2])/3;for(let c=0;c<3;c++)data[i+c]=Math.max(0,Math.min(255,mean+(data[i+c]-mean)*1.15));}
      }else if(filter==='shadows'){
        cv.cvtColor(src,gray,cv.COLOR_RGBA2GRAY);const background=keep(new cv.Mat()),kernel=keep(cv.getStructuringElement(cv.MORPH_RECT,new cv.Size(21,21)));
        cv.dilate(gray,background,kernel);cv.GaussianBlur(background,background,new cv.Size(0,0),13);
        src.copyTo(result);const data=result.data,base=background.data;
        for(let p=0;p<base.length;p++){const factor=245/Math.max(30,base[p]);for(let c=0;c<3;c++)data[p*4+c]=Math.min(255,Math.round(data[p*4+c]*factor));}
      }else src.copyTo(result);
      cv.imshow(output,result);return output;
    }finally{mats.reverse().forEach(m=>m.delete());}
  }
  function rotateCanvas(source,rotation) {
    const sideways=rotation%180!==0,out=canvas(sideways?source.height:source.width,sideways?source.width:source.height),ctx=out.getContext('2d');
    ctx.translate(out.width/2,out.height/2);ctx.rotate(rotation*Math.PI/180);ctx.drawImage(source,-source.width/2,-source.height/2);return out;
  }
  function renderEdited() {
    if(!state.warped)return;const brightness=Number($('brightnessRange').value),contrast=Number($('contrastRange').value);
    $('brightnessValue').value=brightness;$('contrastValue').value=contrast;
    const filtered=filteredCanvas(state.warped,state.filter),ctx=filtered.getContext('2d',{willReadFrequently:true}),data=ctx.getImageData(0,0,filtered.width,filtered.height),gain=(100+contrast)/100;
    if(brightness||contrast){for(let i=0;i<data.data.length;i+=4)for(let c=0;c<3;c++)data.data[i+c]=(data.data[i+c]-128)*gain+128+brightness*2;ctx.putImageData(data,0,0);}
    const rotated=rotateCanvas(filtered,state.rotation),target=$('editCanvas');target.width=rotated.width;target.height=rotated.height;target.getContext('2d').drawImage(rotated,0,0);
    $$('[data-filter]').forEach(button=>{const active=button.dataset.filter===state.filter;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  }
  async function renderFilterThumbnails() {
    const source=state.warped,scale=Math.min(1,160/Math.max(source.width,source.height)),small=canvas(Math.round(source.width*scale),Math.round(source.height*scale));small.getContext('2d').drawImage(source,0,0,small.width,small.height);
    for(const button of $$('[data-filter]')){const filtered=filteredCanvas(small,button.dataset.filter),target=button.querySelector('canvas'),ctx=target.getContext('2d'),ratio=Math.min(target.width/filtered.width,target.height/filtered.height);ctx.clearRect(0,0,target.width,target.height);ctx.drawImage(filtered,(target.width-filtered.width*ratio)/2,(target.height-filtered.height*ratio)/2,filtered.width*ratio,filtered.height*ratio);await nextPaint();}
  }
  async function acceptPage() {
    await busy(async()=>{
      const edited=$('editCanvas');state.doc??={id:null,name:t('draft'),pages:[],format:'pdf',quality:'medium'};
      state.doc.pages.push({id:uid(),blob:await canvasBlob(edited,.95),width:edited.width,height:edited.height});state.dirty=true;state.pageIndex=state.doc.pages.length-1;state.doc.exportBlob=null;state.doc.exportPages=null;state.source=null;state.warped=null;
      if(state.queue.length){const file=state.queue.shift();await beginImage(await decodeImage(file));}else{view('document');renderDocument();}
    });
  }
  async function openDocument(id) {
    if(state.dirty&&!await leaveCurrent())return;const record=state.records.find(d=>d.id===id);if(!record)return;
    state.doc=structuredClone(record);state.dirty=false;state.pageIndex=0;view('document');renderDocument();
  }
  function renderDocument() {
    if(!state.doc)return;releaseUrls();const doc=state.doc,isDraft=!doc.id;
    $('documentTitle').textContent=isDraft?t('draft'):doc.name;
    $('documentMeta').textContent=t('pageCount',{n:doc.pages.length})+(state.dirty?' · '+t('unsaved'):'');
    $('saveDraftButton').hidden=!isDraft;$('savePageChangesButton').hidden=isDraft||!state.dirty;
    ['shareDocumentButton','downloadDocumentButton','renameDocumentButton','ocrDocumentButton','deleteDocumentButton'].forEach(id=>$(id).hidden=isDraft);
    const list=$('pageList');list.replaceChildren();
    doc.pages.forEach((page,index)=>{
      const card=$('pageCardTemplate').content.firstElementChild.cloneNode(true);translate(card);card.dataset.index=index;
      card.classList.toggle('selected-page',index===state.pageIndex);card.querySelector('.page-number').textContent=t('pageNumber',{n:index+1});card.querySelector('.page-thumbnail').src=blobUrl(page.blob);
      card.querySelector('.page-open').onclick=()=>openPreview(index);
      card.querySelector('.page-move-before').disabled=index===0;card.querySelector('.page-move-after').disabled=index===doc.pages.length-1;
      card.querySelector('.page-move-before').onclick=()=>movePage(index,index-1);card.querySelector('.page-move-after').onclick=()=>movePage(index,index+1);
      card.querySelector('.page-delete').onclick=safe(async()=>{if(doc.pages.length===1){toast(t('lastPage'),true);return;}if(await confirm(t('deletePage'))){doc.pages.splice(index,1);state.pageIndex=Math.min(state.pageIndex,doc.pages.length-1);markDirty();renderDocument();}});
      bindPageDrag(card,index);list.append(card);
    });
  }
  function markDirty(){state.dirty=true;if(state.doc){state.doc.exportBlob=null;state.doc.exportPages=null;}}
  function movePage(from,to){if(to<0||to>=state.doc.pages.length||from===to)return;const [page]=state.doc.pages.splice(from,1);state.doc.pages.splice(to,0,page);state.pageIndex=to;markDirty();renderDocument();}
  function bindPageDrag(card,index) {
    const handle=card.querySelector('.page-drag-handle');let target=index,active=false;
    handle.addEventListener('pointerdown',event=>{active=true;target=index;handle.setPointerCapture(event.pointerId);card.classList.add('dragging');});
    handle.addEventListener('pointermove',event=>{
      if(!active)return;event.preventDefault();const under=document.elementFromPoint(event.clientX,event.clientY)?.closest('.page-card');
      $$('.page-card').forEach(el=>el.classList.remove('drop-target'));if(under){target=Number(under.dataset.index);under.classList.add('drop-target');}
      if(event.clientY<110)window.scrollBy(0,-16);else if(event.clientY>innerHeight-125)window.scrollBy(0,16);
    });
    const finish=event=>{if(!active)return;active=false;card.classList.remove('dragging');$$('.page-card').forEach(el=>el.classList.remove('drop-target'));if(event.type!=='pointercancel')movePage(index,target);};
    handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
  }
  function openPreview(index){state.pageIndex=index;updatePreview();$('pagePreviewDialog').showModal();}
  function updatePreview(){const doc=state.doc,index=state.pageIndex;$('pagePreviewImage').src=blobUrl(doc.pages[index].blob);$('pagePreviewCounter').textContent=`${index+1} / ${doc.pages.length}`;$('previousPageButton').disabled=index===0;$('nextPageButton').disabled=index===doc.pages.length-1;}
  async function buildExports(doc) {
    if(doc.exportPages&&(doc.format!=='pdf'||doc.exportBlob))return;
    const quality={high:{max:2400,q:.93},medium:{max:1800,q:.82},small:{max:1200,q:.65}}[doc.quality]||{max:1800,q:.82};
    const images=[];
    for(const page of doc.pages){const image=await decodeImage(page.blob,quality.max);images.push({blob:await canvasBlob(image,quality.q),width:image.width,height:image.height});await nextPaint();}
    let pdfBlob=null;
    if(doc.format==='pdf'){
      const jsPDF=await ensurePDF();let pdf;
      for(let i=0;i<images.length;i++){
        const page=images[i],w=page.width*.264583,h=page.height*.264583,orientation=w>h?'landscape':'portrait';
        if(i===0)pdf=new jsPDF({unit:'mm',format:[w,h],orientation,compress:true});else pdf.addPage([w,h],orientation);
        pdf.addImage(new Uint8Array(await page.blob.arrayBuffer()),'JPEG',0,0,w,h,undefined,'FAST');
      }pdfBlob=pdf.output('blob');
    }
    doc.exportPages=images;doc.exportBlob=pdfBlob;
  }
  async function thumbnailFor(blob){const image=await decodeImage(blob,280);return canvasBlob(image,.75);}
  async function saveDraft(event) {
    event.preventDefault();if(state.busy)return;const button=$('saveSubmitButton');button.disabled=true;$('saveError').hidden=true;
    try {
      const name=cleanName($('fileNameInput').value);if(!name)throw userError('emptyName');
      await busy(async()=>{
        const doc=state.doc;doc.format=document.querySelector('[name="outputFormat"]:checked').value;doc.quality=$('qualitySelect').value;doc.exportPages=null;doc.exportBlob=null;
        await buildExports(doc);doc.thumbnail=await thumbnailFor(doc.pages[0].blob);
        state.doc=await dbSave(doc,name);state.dirty=false;$('saveDialog').close();await refreshLibrary();view('document');renderDocument();toast(t('saved'));refreshStorage();
      });
    }catch(error){$('saveError').textContent=errorMessage(error);$('saveError').hidden=false;}finally{button.disabled=false;}
  }
  async function saveChanges(){await busy(async()=>{await buildExports(state.doc);state.doc.thumbnail=await thumbnailFor(state.doc.pages[0].blob);state.doc=await dbSave(state.doc,state.doc.name);state.dirty=false;await refreshLibrary();renderDocument();toast(t('changesSaved'));refreshStorage();});}
  function showSaveDialog(){if(!state.doc?.pages.length)return;$('fileNameInput').value=defaultName();$('saveError').hidden=true;$('saveDialog').showModal();$('fileNameInput').select();}
  let renameTarget=null;
  function openRename(doc){renameTarget=doc;$('renameInput').value=doc.name;$('renameError').hidden=true;$('renameDialog').showModal();$('renameInput').select();}
  async function renameDocument(event){
    event.preventDefault();try{const saved=await dbSave(renameTarget,$('renameInput').value);if(state.doc?.id===saved.id){state.doc.name=saved.name;state.doc.nameKey=saved.nameKey;renderDocument();}$('renameDialog').close();await refreshLibrary();toast(t('renamed'));}catch(error){$('renameError').textContent=errorMessage(error);$('renameError').hidden=false;}
  }
  async function deleteDocs(ids){
    if(!ids.length||!await confirm(t('deleteDocs',{n:ids.length})))return;
    await dbDelete(ids);if(ids.includes(state.doc?.id)){state.doc=null;state.dirty=false;view('library');}state.selected.clear();state.selecting=false;await refreshLibrary();toast(t('removed'));refreshStorage();
  }
  function exportFiles(doc){
    const name=cleanName(doc.name)||defaultName();
    if(doc.format==='pdf')return[new File([doc.exportBlob],name+'.pdf',{type:'application/pdf'})];
    return doc.exportPages.map((page,i)=>new File([page.blob],`${name}${doc.pages.length>1?'_'+String(i+1).padStart(2,'0'):''}.jpg`,{type:'image/jpeg'}));
  }
  function triggerDownloads(files){
    files.forEach((file,i)=>setTimeout(()=>{const url=URL.createObjectURL(file),link=document.createElement('a');link.href=url;link.download=file.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);},i*500));
  }
  async function downloadDocs(docs){await busy(async()=>{for(const doc of docs)await buildExports(doc);triggerDownloads(docs.flatMap(exportFiles));toast(t('downloading'));});}
  async function shareDocs(docs){
    const missing=docs.some(doc=>!doc.exportPages||(doc.format==='pdf'&&!doc.exportBlob));
    if(missing){await busy(async()=>{for(const doc of docs)await buildExports(doc);});toast(t('shareReady'));return;}
    const files=docs.flatMap(exportFiles);
    if(navigator.share&&navigator.canShare?.({files})){
      try{await navigator.share({files,title:docs.length===1?docs[0].name:'Gomaa Scan'});}catch(error){if(error.name!=='AbortError'){triggerDownloads(files);toast(t('shareFallback'));}}
    }else{triggerDownloads(files);toast(t('shareFallback'));}
  }
  async function refreshStorage(){
    try{if(navigator.storage?.estimate){const info=await navigator.storage.estimate();$('storageUsage').textContent=t('usage',{used:formatBytes(info.usage||0),total:formatBytes(info.quota||0)});}
      $('persistenceStatus').textContent=navigator.storage?.persisted?t(await navigator.storage.persisted()?'persistent':'notPersistent'):t('storageUnsupported');$('persistStorageButton').disabled=!navigator.storage?.persist;
    }catch{$('persistenceStatus').textContent=t('storageUnsupported');}
  }
  function formatBytes(bytes){return bytes>=1048576?(bytes/1048576).toFixed(1)+' MB':Math.round(bytes/1024)+' KB';}
  function openOCR(){if(!state.doc?.pages.length)return;$('ocrText').value='';$('copyOcrButton').disabled=true;$('ocrStatus').textContent=t('ocrHint');$('ocrDialog').showModal();}
  async function stopOCR(){state.ocrRun++;const worker=state.ocrWorker;state.ocrWorker=null;try{await worker?.terminate();}catch{}$('startOcrButton').disabled=false;$('ocrLanguageSelect').disabled=$('ocrScopeSelect').disabled=false;$('cancelOcrButton').hidden=true;$('ocrProgress').hidden=true;}
  async function startOCR(){
    const run=++state.ocrRun,scope=$('ocrScopeSelect').value,pages=scope==='current'?[state.doc.pages[state.pageIndex]]:[...state.doc.pages],language=$('ocrLanguageSelect').value;
    $('startOcrButton').disabled=true;$('ocrLanguageSelect').disabled=$('ocrScopeSelect').disabled=true;$('cancelOcrButton').hidden=false;$('ocrProgress').hidden=false;$('ocrProgress').value=0;$('ocrText').value='';$('copyOcrButton').disabled=true;$('ocrStatus').textContent=t('ocrLoading');
    let worker,workerObjectUrl,pageNumber=0;
    try{
      const OCR=await ensureOCR();
      const response=await fetch(CDN.worker);if(!response.ok)throw userError('loadFailed');
      workerObjectUrl=URL.createObjectURL(new Blob([await response.text()],{type:'text/javascript'}));
      if(run!==state.ocrRun)return;
      worker=await OCR.createWorker(language,1,{
        workerPath:workerObjectUrl,workerBlobURL:false,corePath:CDN.core,
        langPath:CDN.lang,
        logger:message=>{if(run===state.ocrRun&&message.status==='recognizing text')$('ocrProgress').value=(pageNumber+message.progress)/pages.length;},
        errorHandler:()=>{}
      });
      if(run!==state.ocrRun){await worker.terminate();return;}state.ocrWorker=worker;
      for(pageNumber=0;pageNumber<pages.length;pageNumber++){
        $('ocrStatus').textContent=t('ocrPage',{n:pageNumber+1,total:pages.length});
        const result=await worker.recognize(pages[pageNumber].blob);if(run!==state.ocrRun)return;
        $('ocrText').value+=($('ocrText').value?'\n\n':'')+result.data.text.trim();$('copyOcrButton').disabled=!$('ocrText').value.trim();
      }$('ocrProgress').value=1;$('ocrStatus').textContent=t('ocrDone');
    }catch(error){if(run===state.ocrRun){$('ocrStatus').textContent=errorMessage(error);toast(errorMessage(error),true);}}
    finally{try{await worker?.terminate();}catch{}if(workerObjectUrl)URL.revokeObjectURL(workerObjectUrl);if(run===state.ocrRun){state.ocrWorker=null;$('startOcrButton').disabled=false;$('ocrLanguageSelect').disabled=$('ocrScopeSelect').disabled=false;$('cancelOcrButton').hidden=true;$('ocrProgress').hidden=true;}}
  }
  async function waitForSW(){
    if(!('serviceWorker' in navigator)||!isSecureContext)throw userError('swUnavailable');
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(userError('swUnavailable')),12000))]);
    if(!navigator.serviceWorker.controller)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(userError('swUnavailable')),6000);navigator.serviceWorker.addEventListener('controllerchange',()=>{clearTimeout(timer);resolve();},{once:true});});
    return navigator.serviceWorker.controller;
  }
  async function swRequest(type,onProgress){
    const controller=await waitForSW();return new Promise((resolve,reject)=>{
      const channel=new MessageChannel();let timer;const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>{channel.port1.close();reject(userError('offlineNeedOnline'));},120000);};reset();
      channel.port1.onmessage=event=>{reset();const data=event.data;if(data.type==='progress'){onProgress?.(data);return;}clearTimeout(timer);channel.port1.close();data.ok?resolve(data):reject(userError(data.error||'offlineNeedOnline'));};controller.postMessage({type},[channel.port2]);
    });
  }
  async function checkOffline(){
    if(state.offlineRunning)return;
    try{const status=await swRequest('STATUS');$('offlineReadyStatus').textContent=status.ready?t('offlineReady'):t('offlinePartial',{n:status.cached,total:status.total});}
    catch{$('offlineReadyStatus').textContent=t('swUnavailable');}
  }
  async function prepareOffline(){
    if(state.offlineRunning)return;state.offlineRunning=true;$('prepareOfflineButton').disabled=true;$('offlineProgress').hidden=false;
    try{const result=await swRequest('PREPARE',data=>{$('offlineProgress').value=data.completed/data.total;$('offlineReadyStatus').textContent=t('offlinePartial',{n:data.completed,total:data.total});});$('offlineReadyStatus').textContent=t('offlineReady');$('offlineProgress').value=1;toast(t('offlineReady'));if(!result.ready)throw userError('offlineNeedOnline');}
    catch(error){$('offlineReadyStatus').textContent=errorMessage(error);toast(errorMessage(error),true);}
    finally{state.offlineRunning=false;$('prepareOfflineButton').disabled=false;$('offlineProgress').hidden=true;refreshStorage();}
  }
  async function install(){if(state.installEvent){await state.installEvent.prompt();await state.installEvent.userChoice;state.installEvent=null;$('installBanner').hidden=true;$('settingsInstallButton').hidden=true;}else toast(t('installHelp'));}
  async function newScan(){if(!await leaveCurrent())return;state.doc={id:null,name:t('draft'),pages:[],format:'pdf',quality:'medium'};state.dirty=false;view('scan');await startCamera();}
  async function navigate(name){
    if(name==='scan'){await newScan();return;}
    if(!await leaveCurrent())return;view(name);if(name==='library')renderLibrary();else{refreshStorage();checkOffline();}
  }
  async function cancelEditing(){
    if(!await confirm(t('discard'),t('discardTitle'),t('discardAction')))return;state.queue=[];state.source=null;state.warped=null;
    if(state.doc?.pages.length){view('document');renderDocument();}else{state.doc=null;state.dirty=false;view('library');renderLibrary();}
  }
  function bindEvents(){
    $$('[data-action="new-scan"]').forEach(button=>button.onclick=safe(newScan));
    $$('[data-action="import-images"]').forEach(button=>button.onclick=()=>{$('imageInput').click();});
    $$('[data-nav]').forEach(button=>button.onclick=safe(()=>navigate(button.dataset.nav)));
    document.querySelector('.brand').onclick=safe(async event=>{event.preventDefault();await navigate('library');});
    $('imageInput').onchange=safe(importImages);$('searchInput').oninput=renderLibrary;$('sortSelect').onchange=renderLibrary;
    function setLayout(mode){$('documentGrid').classList.toggle('list-mode',mode==='list');$('listViewButton').classList.toggle('active',mode==='list');$('gridViewButton').classList.toggle('active',mode!=='list');$('listViewButton').setAttribute('aria-pressed',String(mode==='list'));$('gridViewButton').setAttribute('aria-pressed',String(mode!=='list'));pref('layout',mode);}
    $('gridViewButton').onclick=()=>setLayout('grid');$('listViewButton').onclick=()=>setLayout('list');setLayout(pref('layout')||'grid');
    $('selectModeButton').onclick=()=>{state.selecting=!state.selecting;state.selected.clear();renderLibrary();};
    $('cancelSelectionButton').onclick=()=>{state.selecting=false;state.selected.clear();renderLibrary();};
    $('selectAllButton').onclick=()=>{const ids=state.records.filter(doc=>doc.name.toLocaleLowerCase().includes($('searchInput').value.trim().toLocaleLowerCase())).map(doc=>doc.id);const all=ids.every(id=>state.selected.has(id));ids.forEach(id=>all?state.selected.delete(id):state.selected.add(id));renderLibrary();};
    $('deleteSelectedButton').onclick=safe(()=>deleteDocs([...state.selected]));$('shareSelectedButton').onclick=safe(()=>shareDocs(state.records.filter(doc=>state.selected.has(doc.id))));
    $('captureButton').onclick=safe(captureImage);$('retryCameraButton').onclick=safe(startCamera);$('closeScanButton').onclick=safe(async()=>{if(state.doc?.pages.length){view('document');renderDocument();}else await navigate('library');});
    $('autoCaptureToggle').onchange=()=>state.stableSince=performance.now();
    $('torchButton').onclick=safe(async()=>{const track=state.stream?.getVideoTracks()[0];if(!track)return;await track.applyConstraints({advanced:[{torch:!state.torch}]});state.torch=!state.torch;$('torchButton').setAttribute('aria-pressed',String(state.torch));});
    bindCropHandles();$('fullImageButton').onclick=()=>{state.corners=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];updateCorners();};$('confirmCropButton').onclick=safe(cropImage);$('cancelCropButton').onclick=safe(cancelEditing);
    $('backToCropButton').onclick=()=>{view('crop');updateCorners();};
    $$('[data-filter]').forEach(button=>button.onclick=safe(()=>busy(()=>{state.filter=button.dataset.filter;renderEdited();})));
    let editTimer;$('brightnessRange').oninput=$('contrastRange').oninput=()=>{clearTimeout(editTimer);editTimer=setTimeout(safe(renderEdited),90);};
    $('rotateButton').onclick=safe(()=>busy(()=>{state.rotation=(state.rotation+90)%360;renderEdited();}));
    $('resetAdjustmentsButton').onclick=safe(()=>busy(()=>{state.rotation=0;state.filter='original';$('brightnessRange').value=$('contrastRange').value=0;renderEdited();}));$('acceptPageButton').onclick=safe(acceptPage);
    $('closeDocumentButton').onclick=safe(()=>navigate('library'));$('addPageButton').onclick=safe(async()=>{state.queue=[];view('scan');await startCamera();});
    $('saveDraftButton').onclick=showSaveDialog;$('saveForm').onsubmit=saveDraft;$('savePageChangesButton').onclick=safe(saveChanges);
    $$('[name="outputFormat"]').forEach(radio=>radio.onchange=()=>{$('jpgHint').hidden=document.querySelector('[name="outputFormat"]:checked').value!=='jpg';});
    $('shareDocumentButton').onclick=safe(()=>shareDocs([state.doc]));$('downloadDocumentButton').onclick=safe(()=>downloadDocs([state.doc]));
    $('renameDocumentButton').onclick=()=>openRename(state.doc);$('renameForm').onsubmit=renameDocument;$('deleteDocumentButton').onclick=safe(()=>deleteDocs([state.doc.id]));
    $('ocrDocumentButton').onclick=openOCR;$('startOcrButton').onclick=safe(startOCR);
    $('cancelOcrButton').onclick=safe(async()=>{await stopOCR();$('ocrStatus').textContent=t('ocrStopped');});
    $('closeOcrButton').onclick=()=>{$('ocrDialog').close();};$('ocrDialog').addEventListener('close',safe(stopOCR));
    $('ocrText').oninput=()=>$('copyOcrButton').disabled=!$('ocrText').value.trim();
    $('copyOcrButton').onclick=safe(async()=>{try{await navigator.clipboard.writeText($('ocrText').value);toast(t('copied'));}catch{$('ocrText').focus();$('ocrText').select();toast(t('copyManual'));}});
    $('previousPageButton').onclick=()=>{state.pageIndex--;updatePreview();};$('nextPageButton').onclick=()=>{state.pageIndex++;updatePreview();};
    $('pagePreviewDialog').addEventListener('close',()=>{if(state.doc)renderDocument();});
    $$('[data-close-dialog]').forEach(button=>button.onclick=()=>{if(!state.busy)$(button.dataset.closeDialog).close();});$('saveDialog').addEventListener('cancel',event=>{if(state.busy)event.preventDefault();});
    $('languageSelect').onchange=()=>applyLanguage($('languageSelect').value);$('themeSelect').onchange=()=>applyTheme($('themeSelect').value);
    $('themeToggle').onclick=()=>{const dark=state.theme==='dark'||(state.theme==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);applyTheme(dark?'light':'dark');};
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>applyTheme(state.theme));
    $('persistStorageButton').onclick=safe(async()=>{await navigator.storage?.persist?.();await refreshStorage();});$('prepareOfflineButton').onclick=safe(prepareOffline);
    $('installButton').onclick=$('settingsInstallButton').onclick=safe(install);$('dismissInstall').onclick=()=>{$('installBanner').hidden=true;};
    addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.installEvent=event;$('installBanner').hidden=false;$('settingsInstallButton').hidden=false;});
    addEventListener('appinstalled',()=>{state.installEvent=null;$('installBanner').hidden=true;$('settingsInstallButton').hidden=true;});
    const connectivity=()=>$('offlineBadge').hidden=navigator.onLine;addEventListener('online',connectivity);addEventListener('offline',connectivity);connectivity();
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.stream){stopCamera();$('cameraStatus').textContent=t('cameraPaused');$('retryCameraButton').hidden=false;}});
    addEventListener('pagehide',()=>{stopCamera();state.ocrWorker?.terminate();});
    addEventListener('beforeunload',event=>{if(state.dirty||['crop','edit'].includes(state.view)){event.preventDefault();event.returnValue='';}});
  }
  async function init(){
    seedTranslations(document);$$('template').forEach(el=>seedTranslations(el.content));
    state.lang=pref('lang')==='en'?'en':'ar';state.theme=pref('theme')||'system';bindEvents();applyTheme(state.theme);
    document.documentElement.lang=state.lang;document.documentElement.dir=state.lang==='ar'?'rtl':'ltr';$('languageSelect').value=state.lang;translate();view('library');
    try{await openDatabase();await refreshLibrary();}catch(error){$('storageError').textContent=errorMessage(error);$('storageError').hidden=false;renderLibrary();}
    if('serviceWorker' in navigator&&isSecureContext){try{state.sw=await navigator.serviceWorker.register('./sw.js',{scope:'./'});navigator.serviceWorker.addEventListener('controllerchange',()=>checkOffline());checkOffline();}catch{$('offlineReadyStatus').textContent=t('swUnavailable');}}
    else $('offlineReadyStatus').textContent=t('swUnavailable');refreshStorage();
  }
  safe(init)();
})();
