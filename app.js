const State = {
    apiKey: '', wardrobe: [],
    tempUploadBase64: null, tempUploadMime: null, cavemanMode: false,
    chatHistory: [], savedLooks: []
};

const idb = (method, arg) => new Promise((res, rej) => {
    const s = DB.instance.transaction([DB.storeName], method === 'getAll' || method === 'get' ? 'readonly' : 'readwrite').objectStore(DB.storeName);
    const r = s[method](arg);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej('DB operation failed');
});

const DB = {
    dbName: 'DripChatDB', dbVersion: 1, storeName: 'wardrobe', instance: null,
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);
            request.onerror = () => reject("Failed to open local database.");
            request.onsuccess = (e) => { this.instance = e.target.result; resolve(); };
            request.onupgradeneeded = (e) => {
                if (!e.target.result.objectStoreNames.contains(this.storeName))
                    e.target.result.createObjectStore(this.storeName, { keyPath: 'id', autoIncrement: true });
            };
        });
    },
    addItem: (item) => idb('add', item),
    getAllItems: () => idb('getAll'),
    updateItem: (item) => idb('put', item),
    deleteItem: (id) => idb('delete', id),
    clearAll: () => idb('clear')
};

function compressImage(src) {
    const maxDimension = 600;
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let w = img.width, h = img.height;
            if (w > h) { if (w > maxDimension) { h = Math.round(h * maxDimension / w); w = maxDimension; } }
            else { if (h > maxDimension) { w = Math.round(w * maxDimension / h); h = maxDimension; } }
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.65));
        };
        img.onerror = () => reject("Invalid image file.");
        img.src = src;
    });
}

function calculateFormatSize(items) {
    const bytes = items.reduce((t, i) => {
        const jsonStr = JSON.stringify(i);
        // Count metadata (non-image fields) + actual image bytes (base64 -> raw bytes)
        const metaBytes = jsonStr.length - (i.image ? i.image.length : 0);
        const imageBytes = i.image ? i.image.length * 0.75 : 0;
        return t + metaBytes + imageBytes;
    }, 0);
    return (bytes / (1024 * 1024)).toFixed(2);
}

function cropImage(base64Image, bbox) {
    return new Promise((resolve, reject) => {
        if (!bbox || typeof bbox.x !== 'number' || typeof bbox.y !== 'number' ||
            typeof bbox.w !== 'number' || typeof bbox.h !== 'number') { resolve(base64Image); return; }
        const img = new Image();
        img.onload = () => {
            const x = Math.max(0, Math.round(bbox.x * img.width));
            const y = Math.max(0, Math.round(bbox.y * img.height));
            const w = Math.round(bbox.w * img.width), h = Math.round(bbox.h * img.height);
            if (w < 10 || h < 10) { resolve(base64Image); return; }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', 0.65));
        };
        img.onerror = () => reject("Image crop failed.");
        img.src = base64Image;
    });
}

function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function parseJSON(text) {
    // Strip markdown code fences that LLMs sometimes wrap JSON in
    const cleaned = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
    return JSON.parse(cleaned);
}

function saveChatHistory() {
    // Keep last 50 messages to avoid bloating localStorage
    const toSave = State.chatHistory.slice(-50);
    try { localStorage.setItem('dripchat_chat_history', JSON.stringify(toSave)); }
    catch { /* quota exceeded — ignore */ }
}

function formatRelativeTime(date) {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function showConfirm(message) {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirm-modal');
        document.getElementById('confirm-message').textContent = message;
        modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
        const cleanup = (result) => {
            modal.classList.add('hidden');
            document.body.classList.remove('modal-open');
            okBtn.removeEventListener('click', onOk);
            cancelBtn.removeEventListener('click', onCancel);
            document.removeEventListener('keydown', onKey);
            modal.removeEventListener('click', onBackdrop);
            resolve(result);
        };
        const onOk = () => cleanup(true);
        const onCancel = () => cleanup(false);
        const onKey = (e) => { if (e.key === 'Escape') cleanup(false); };
        const onBackdrop = (e) => { if (e.target === modal) cleanup(false); };
        const okBtn = document.getElementById('btn-confirm-ok');
        const cancelBtn = document.getElementById('btn-confirm-cancel');
        okBtn.addEventListener('click', onOk);
        cancelBtn.addEventListener('click', onCancel);
        document.addEventListener('keydown', onKey);
        modal.addEventListener('click', onBackdrop);
        cancelBtn.focus();
    });
}

function showToast(message, type, duration = 3000) {
    const container = document.getElementById('toast-container');
    // Cap visible toasts at 3
    const existing = container.querySelectorAll('.toast:not(.out)');
    if (existing.length >= 3) existing[0].classList.add('out');
    const el = document.createElement('div');
    el.className = `toast${type ? ' ' + type : ''}`;
    el.textContent = message;
    container.appendChild(el);
    // Telegram haptic feedback
    if (window.Telegram?.WebApp?.HapticFeedback) {
        if (type === 'success') window.Telegram.WebApp.HapticFeedback.notificationOccurred('success');
        else if (type === 'error') window.Telegram.WebApp.HapticFeedback.notificationOccurred('error');
        else window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
    }
    setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => el.remove(), 250);
    }, duration);
}

const TelegramIntegration = {
    init() {
        if (window.Telegram?.WebApp) {
            const tg = window.Telegram.WebApp;
            tg.ready();
            tg.expand();
            document.body.classList.add('in-telegram');
            if (tg.themeParams?.bg_color)
                document.documentElement.style.setProperty('--bg-color', tg.themeParams.bg_color);
        }
        // Offline/online indicators
        window.addEventListener('offline', () => {
            document.body.classList.add('is-offline');
            showToast('You are offline', 'error');
        });
        window.addEventListener('online', () => {
            document.body.classList.remove('is-offline');
            showToast('Back online', 'success');
        });
        if (!navigator.onLine) document.body.classList.add('is-offline');
    }
};

const CATEGORIES = ['tops', 'bottoms', 'outerwear', 'shoes', 'accessories'];
const STYLES = ['casual', 'formal', 'athletic', 'smart-casual', 'streetwear'];
const SEASONS = ['all', 'hot', 'cold', 'mild', 'rainy'];
const CAT_LABELS = { tops: 'Tops', bottoms: 'Bottoms', outerwear: 'Outerwear', shoes: 'Shoes', accessories: 'Accessories' };
const STYLE_LABELS = { casual: 'Casual', formal: 'Formal', athletic: 'Sporty', 'smart-casual': 'Smart Casual', streetwear: 'Streetwear' };
const SEASON_LABELS = { all: 'Any Weather', hot: 'Warm / Summer', cold: 'Cold / Winter', mild: 'Mild / Spring & Autumn', rainy: 'Rainy / Wet' };
const opts = (list, labels, val) => list.map(v => `<option value="${v}"${val === v ? ' selected' : ''}>${labels[v]}</option>`).join('');
const FALLBACK_ITEM = { name: '', category: 'tops', colorHex: '#3b82f6', colorName: '', style: 'casual', season: 'all', notes: '' };

const Gemini = {
    async callAPI(payload, systemInstruction = null, retries = 3) {
        if (!State.apiKey) throw new Error("No Gemini API key supplied. Go to Settings to enter one.");
        if (!navigator.onLine) throw new Error("You're offline. Please check your internet connection.");
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${State.apiKey}`;
        const body = { contents: payload.contents };
        if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
        if (payload.jsonMode) body.generationConfig = { responseMimeType: "application/json" };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        let res;
        try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }); }
        finally { clearTimeout(timeout); }
        if (!res.ok) {
            const errMsg = (await res.json().catch(() => ({}))).error?.message || `HTTP error ${res.status}`;
            const m = errMsg.match(/retry in (\d+(?:\.\d+)?)s/i);
            if (m && retries > 0) {
                await new Promise(r => setTimeout(r, Math.ceil(parseFloat(m[1]) * 1000) + 500));
                return this.callAPI(payload, systemInstruction, retries - 1);
            }
            throw new Error(errMsg);
        }
        const text = (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Empty response from Gemini AI.");
        return text;
    },

    async autoTagClothingItem(base64Image, mimeType) {
        const payload = {
            jsonMode: true,
            contents: [{ parts: [
                { text: `Analyze clothing photo. Return JSON array of distinct items found.
Each object: {"name":"short name","category":"tops|bottoms|outerwear|shoes|accessories","colorName":"primary+accent colors","colorHex":"#hex","style":"casual|formal|athletic|smart-casual|streetwear","season":"all|hot|cold|mild|rainy","notes":"color layout, textures, fit description for stylist"}` },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image.split(',')[1] } }
            ]}]
        };
        return parseJSON(await this.callAPI(payload));
    },

    async suggestOutfit(userInput, extraInstruction = null) {
        const list = State.wardrobe.map(i => `- [ID:${i.id}] ${i.name} (${i.category}, ${i.colorName}, ${i.style}, ${i.season})`).join('\n');
        let system = `You are DripChat, a stylish wardrobe assistant. User's wardrobe:\n${list || 'Empty. Ask them to add clothes first.'}\n\nRules: 1) ONLY recommend items EXACTLY from wardrobe above. 2) Suggest 2-3 outfits for their scenario. 3) Brief, fashion-forward, bold headings, smartphone-friendly. 4) After EACH look, on a new line put: [IDs: {comma-separated item IDs}]. This ID line is internal only.`;
        if (extraInstruction) system = `${extraInstruction}\n\n${system}`;
        const history = State.chatHistory.slice(-6).map(m => ({
            role: m.role,
            parts: [{ text: m.role === 'model' ? m.text.replace(/\[IDs:.*?\]/gi, '').trim() : m.text }]
        }));
        history.push({ role: 'user', parts: [{ text: userInput }] });
        return this.callAPI({ contents: history }, system);
    },

    async analyzeWardrobeGaps() {
        const list = State.wardrobe.map(i => `- ${i.name} (${i.category}, ${i.colorName}, ${i.style}, ${i.season})`).join('\n');
        const system = `Analyze wardrobe inventory and recommend 3 strategic purchases to maximize outfit versatility. Return JSON array strictly:
[{"title":"specific item to buy","category":"shoes|tops|bottoms|outerwear|accessories","priority":"high|medium","reason":"why it fills a gap"}]
Inventory:\n${list || 'EMPTY'}`;
        return parseJSON(await this.callAPI({ jsonMode: true, contents: [{ parts: [{ text: 'Analyze my wardrobe gaps.' }] }] }, system));
    }
};

const CropTool = {
    img: null, wrapper: null, box: null,
    viewW: 0, viewH: 0, offsetX: 0, offsetY: 0,
    dragging: false, mode: 'move', startX: 0, startY: 0,
    boxStart: {},
    resolve: null,

    open(base64) {
        return new Promise((resolve) => {
            this.resolve = resolve;
            document.getElementById('crop-modal').classList.remove('hidden');
            document.body.classList.add('modal-open');
            const img = document.getElementById('crop-image');
            img.onload = () => {
                this.img = img;
                this.wrapper = document.getElementById('crop-wrapper');
                this.box = document.getElementById('crop-box');
                // Defer dimension calculation until after the browser has painted
                // the now-visible modal, so getBoundingClientRect() returns real values.
                requestAnimationFrame(() => {
                    this.calcDimensions();
                    this.initBox();
                    this.bindEvents();
                });
            };
            img.src = base64;
        });
    },

    close() {
        document.getElementById('crop-modal').classList.add('hidden');
        document.body.classList.remove('modal-open');
        this.unbindEvents();
    },

    calcDimensions() {
        const wr = this.wrapper.getBoundingClientRect();
        const ir = this.img.getBoundingClientRect();
        const s = Math.min(wr.width / this.img.naturalWidth, wr.height / this.img.naturalHeight, 1);
        this.viewW = this.img.naturalWidth * s;
        this.viewH = this.img.naturalHeight * s;
        this.offsetX = ir.left - wr.left;
        this.offsetY = ir.top - wr.top;
    },

    initBox() {
        const pad = 0.1;
        const l = this.offsetX + this.viewW * pad;
        const t = this.offsetY + this.viewH * pad;
        const w = this.viewW * (1 - 2 * pad);
        const h = this.viewH * (1 - 2 * pad);
        this.box.style.left = l + 'px';
        this.box.style.top = t + 'px';
        this.box.style.width = w + 'px';
        this.box.style.height = h + 'px';
    },

    bindEvents() {
        this.onPointerDown = this.handlePointerDown.bind(this);
        this.onPointerMove = this.handlePointerMove.bind(this);
        this.onPointerUp = this.handlePointerUp.bind(this);
        this.onConfirm = () => this.confirm();
        this.onCancel = () => this.cancel();
        this.box.addEventListener('mousedown', this.onPointerDown);
        this.box.addEventListener('touchstart', this.onPointerDown, { passive: false });
        document.addEventListener('mousemove', this.onPointerMove);
        document.addEventListener('mouseup', this.onPointerUp);
        document.addEventListener('touchmove', this.onPointerMove, { passive: false });
        document.addEventListener('touchend', this.onPointerUp);
        document.getElementById('btn-crop-confirm').addEventListener('click', this.onConfirm);
        document.getElementById('btn-crop-cancel').addEventListener('click', this.onCancel);
    },

    unbindEvents() {
        this.box?.removeEventListener('mousedown', this.onPointerDown);
        this.box?.removeEventListener('touchstart', this.onPointerDown);
        document.removeEventListener('mousemove', this.onPointerMove);
        document.removeEventListener('mouseup', this.onPointerUp);
        document.removeEventListener('touchmove', this.onPointerMove);
        document.removeEventListener('touchend', this.onPointerUp);
        document.getElementById('btn-crop-confirm')?.removeEventListener('click', this.onConfirm);
        document.getElementById('btn-crop-cancel')?.removeEventListener('click', this.onCancel);
    },

    getPos(e) {
        const p = e.touches ? e.touches[0] : e;
        return { x: p.clientX, y: p.clientY };
    },

    handlePointerDown(e) {
        e.preventDefault();
        const handle = e.target.closest('.crop-handle');
        if (handle) {
            this.mode = 'resize-' + handle.getAttribute('data-dir');
        } else {
            this.mode = 'move';
        }
        const pos = this.getPos(e);
        this.startX = pos.x;
        this.startY = pos.y;
        this.dragging = true;
        this.boxStart = {
            left: parseFloat(this.box.style.left),
            top: parseFloat(this.box.style.top),
            width: parseFloat(this.box.style.width),
            height: parseFloat(this.box.style.height)
        };
    },

    handlePointerMove(e) {
        if (!this.dragging) return;
        e.preventDefault();
        const pos = this.getPos(e);
        const dx = pos.x - this.startX;
        const dy = pos.y - this.startY;
        const min = 40;
        let l = this.boxStart.left, t = this.boxStart.top;
        let w = this.boxStart.width, h = this.boxStart.height;

        if (this.mode === 'move') {
            l += dx; t += dy;
        } else if (this.mode === 'resize-se') {
            w = Math.max(min, this.boxStart.width + dx);
            h = Math.max(min, this.boxStart.height + dy);
        } else if (this.mode === 'resize-sw') {
            w = Math.max(min, this.boxStart.width - dx);
            h = Math.max(min, this.boxStart.height + dy);
            l += this.boxStart.width - w;
        } else if (this.mode === 'resize-ne') {
            w = Math.max(min, this.boxStart.width + dx);
            h = Math.max(min, this.boxStart.height - dy);
            t += this.boxStart.height - h;
        } else if (this.mode === 'resize-nw') {
            w = Math.max(min, this.boxStart.width - dx);
            h = Math.max(min, this.boxStart.height - dy);
            l += this.boxStart.width - w;
            t += this.boxStart.height - h;
        }

        const maxL = this.offsetX + this.viewW - 10;
        const maxT = this.offsetY + this.viewH - 10;
        const minL = this.offsetX;
        const minT = this.offsetY;
        l = Math.max(minL, Math.min(maxL - w, l));
        t = Math.max(minT, Math.min(maxT - h, t));
        w = Math.max(min, Math.min(this.offsetX + this.viewW - l, w));
        h = Math.max(min, Math.min(this.offsetY + this.viewH - t, h));

        this.box.style.left = l + 'px';
        this.box.style.top = t + 'px';
        this.box.style.width = w + 'px';
        this.box.style.height = h + 'px';
    },

    handlePointerUp() {
        this.dragging = false;
    },

    getRect() {
        const l = parseFloat(this.box.style.left);
        const t = parseFloat(this.box.style.top);
        const w = parseFloat(this.box.style.width);
        const h = parseFloat(this.box.style.height);
        return {
            x: (l - this.offsetX) / this.viewW,
            y: (t - this.offsetY) / this.viewH,
            w: w / this.viewW,
            h: h / this.viewH
        };
    },

    confirm() {
        const rect = this.getRect();
        this.close();
        this.resolve(rect);
    },

    cancel() {
        this.close();
        this.resolve(null);
    }
};

const UI = {
    init() {
        this.setupNavigation();
        this.setupUploader();
        this.setupSettings();
        this.setupChat();
        this.setupWardrobeViews();
        this.setupGapAnalysis();
        this.updateConnectionStatus();
        this.setupRipple();
        this.setupSwipeNav();
    },

    setupNavigation() {
        document.querySelectorAll('.nav-tab').forEach(t => t.addEventListener('click', () => {
            if (window.Telegram?.WebApp?.HapticFeedback) window.Telegram.WebApp.HapticFeedback.impactOccurred('light');
            this.switchView(t.getAttribute('data-target'));
        }));
        document.querySelector('.btn-tab-trigger')?.addEventListener('click', (e) => this.switchView(e.currentTarget.getAttribute('data-target')));
    },

    switchView(viewId) {
        const currentActive = document.querySelector('.app-view.active');
        if (currentActive && currentActive.id !== viewId) {
            currentActive.classList.remove('active');
            currentActive.classList.add('exiting');
            setTimeout(() => currentActive.classList.remove('exiting'), 200);
        } else if (currentActive) {
            currentActive.classList.remove('active');
        }
        document.getElementById(viewId).classList.add('active');
        document.querySelectorAll('.nav-tab').forEach(t => {
            const isActive = t.getAttribute('data-target') === viewId;
            t.classList.toggle('active', isActive);
            t.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });
        if (viewId === 'view-wardrobe') this.renderWardrobe();
        else if (viewId === 'view-settings') this.renderStorageStats();
        else if (viewId === 'view-shop') this.renderSavedLooks();
    },

    setupWardrobeViews() {
        document.querySelector('.filter-bar').addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (!chip) return;
            if (chip.classList.contains('active')) return;
            document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const searchInput = document.getElementById('wardrobe-search');
            const sortSelect = document.getElementById('wardrobe-sort');
            this.renderWardrobe(chip.getAttribute('data-category'), searchInput.value.trim().toLowerCase(), sortSelect.value);
        });
        const searchInput = document.getElementById('wardrobe-search');
        const sortSelect = document.getElementById('wardrobe-sort');
        const triggerRender = () => {
            const activeChip = document.querySelector('.filter-chip.active');
            const filter = activeChip ? activeChip.getAttribute('data-category') : 'all';
            this.renderWardrobe(filter, searchInput.value.trim().toLowerCase(), sortSelect.value);
        };
        searchInput.addEventListener('input', triggerRender);
        sortSelect.addEventListener('change', triggerRender);

        const closeItemModal = () => {
            document.getElementById('item-modal').classList.add('hidden');
            document.body.classList.remove('modal-open');
        };
        document.getElementById('btn-close-modal').addEventListener('click', closeItemModal);
        document.getElementById('item-modal').addEventListener('click', (e) => { if (e.target.id === 'item-modal') closeItemModal(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !document.getElementById('item-modal').classList.contains('hidden')) closeItemModal();
        });
    },

    renderWardrobe(filter = 'all', search = '', sort = 'newest') {
        const grid = document.getElementById('wardrobe-grid');
        const empty = document.getElementById('wardrobe-empty');
        let items = filter === 'all' ? [...State.wardrobe] : State.wardrobe.filter(i => i.category === filter);
        if (search) items = items.filter(i => i.name.toLowerCase().includes(search) || (i.colorName && i.colorName.toLowerCase().includes(search)));
        // Sort
        if (sort === 'newest') items.sort((a, b) => (b.id || 0) - (a.id || 0));
        else if (sort === 'oldest') items.sort((a, b) => (a.id || 0) - (b.id || 0));
        else if (sort === 'name-az') items.sort((a, b) => a.name.localeCompare(b.name));
        else if (sort === 'name-za') items.sort((a, b) => b.name.localeCompare(a.name));
        else if (sort === 'category') items.sort((a, b) => a.category.localeCompare(b.category));
        grid.querySelectorAll('.item-card').forEach(el => el.remove());
        if (items.length === 0) {
            empty.classList.remove('hidden');
            empty.querySelector('h3').innerText = filter === 'all' ? 'Your wardrobe is empty' : 'No items in this category';
            empty.querySelector('p').innerText = filter === 'all' ? 'Upload photos of your clothes to get AI outfit suggestions!' : `You haven't uploaded any clothing items under "${filter}" yet.`;
            return;
        }
        empty.classList.add('hidden');
        const frag = document.createDocumentFragment();
        items.forEach((item, i) => {
            const card = document.createElement('div');
            card.className = 'item-card';
            card.style.setProperty('--i', i);
            card.innerHTML = `<div class="card-img-wrapper"><img data-src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}"><span class="card-badge">${escapeHtml(item.category)}</span></div><div class="card-info"><h4>${escapeHtml(item.name)}</h4><div class="card-meta"><span>${escapeHtml(item.style)}</span><div class="card-color-indicator" style="background:${escapeHtml(item.colorHex)}" title="${escapeHtml(item.colorName)}"></div></div></div>`;
            card.addEventListener('click', () => this.showItemDetails(item));
            frag.appendChild(card);
        });
        grid.appendChild(frag);
        // Lazy-load images using IntersectionObserver
        this.observeCardImages(grid);
    },

    observeCardImages(container) {
        if (!window.IntersectionObserver) {
            // Fallback for browsers without IO: load all immediately
            container.querySelectorAll('img[data-src]').forEach(img => {
                img.src = img.getAttribute('data-src');
                img.removeAttribute('data-src');
                img.classList.add('loaded');
            });
            return;
        }
        const observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.src = img.getAttribute('data-src');
                    img.removeAttribute('data-src');
                    img.addEventListener('load', () => img.classList.add('loaded'));
                    observer.unobserve(img);
                }
            }
        }, { root: document.getElementById('app-main'), rootMargin: '200px' });
        container.querySelectorAll('img[data-src]').forEach(img => observer.observe(img));
    },

    showItemDetails(item) {
        const modal = document.getElementById('item-modal');
        document.getElementById('modal-item-img').src = item.image;
        document.getElementById('modal-item-category').innerText = item.category;
        document.getElementById('modal-item-name').innerText = item.name;
        document.getElementById('modal-item-style').innerHTML = `&#9889; ${item.style}`;
        document.getElementById('modal-item-season').innerHTML = `&#127734; ${item.season}`;
        document.getElementById('modal-item-color').innerHTML = `<span class="color-dot" style="background:${item.colorHex}"></span> ${item.colorName}`;
        document.getElementById('modal-item-notes').innerText = item.notes || 'No extra notes provided.';

        // Edit button
        const edit = document.getElementById('btn-edit-item');
        const editClone = edit.cloneNode(true);
        edit.parentNode.replaceChild(editClone, edit);
        editClone.addEventListener('click', () => {
            modal.classList.add('hidden');
            document.body.classList.remove('modal-open');
            this.openEditForm(item);
        });

        // Delete button
        const del = document.getElementById('btn-delete-item');
        const clone = del.cloneNode(true);
        del.parentNode.replaceChild(clone, del);
        clone.addEventListener('click', async () => {
            if (!await showConfirm(`Delete "${item.name}"?`)) return;
            await DB.deleteItem(item.id);
            State.wardrobe = State.wardrobe.filter(w => w.id !== item.id);
            modal.classList.add('hidden');
            document.body.classList.remove('modal-open');
            this.renderWardrobe();
        });
        modal.classList.remove('hidden');
        document.body.classList.add('modal-open');
    },

    openEditForm(item) {
        this._editMode = true;
        this.switchView('view-add');
        document.getElementById('upload-preview').src = item.image;
        document.getElementById('upload-preview-container').classList.remove('hidden');
        document.querySelector('.upload-content').classList.add('hidden');
        State.tempUploadBase64 = item.image;
        State.tempUploadMime = 'image/jpeg';
        this.renderDetectedItems(item);
        document.getElementById('clothing-form').classList.remove('hidden');
        // Temporarily override form submission for edit
        const form = document.getElementById('clothing-form');
        const handler = async (e) => {
            e.preventDefault();
            try {
                item.name = document.querySelector('.detect-item-name')?.value;
                item.category = document.querySelector('.detect-item-category')?.value;
                item.colorHex = document.querySelector('.detect-item-color')?.value;
                item.colorName = document.querySelector('.detect-item-color-name')?.value;
                item.style = document.querySelector('.detect-item-style')?.value;
                item.season = document.querySelector('.detect-item-season')?.value;
                item.notes = document.querySelector('.detect-item-notes')?.value || '';
                item.image = State.tempUploadBase64;
                await DB.updateItem(item);
                const idx = State.wardrobe.findIndex(w => w.id === item.id);
                if (idx !== -1) State.wardrobe[idx] = item;
                showToast('Item updated!', 'success');
                this.resetUploadForm();
                this._editMode = false;
                this.switchView('view-wardrobe');
            } catch (err) {
                showToast('Update failed: ' + err, 'error');
            }
            form.removeEventListener('submit', handler);
            this._editMode = false;
        };
        form.addEventListener('submit', handler);
    },

    setupUploader() {
        const cameraInput = document.getElementById('camera-input');
        const galleryInput = document.getElementById('gallery-input');
        const clearBtn = document.getElementById('btn-clear-upload');
        const form = document.getElementById('clothing-form');

        document.getElementById('btn-take-photo').addEventListener('click', () => cameraInput.click());
        document.getElementById('btn-browse-gallery').addEventListener('click', () => galleryInput.click());

        // Drag and drop support
        const uploadBox = document.getElementById('upload-box');
        uploadBox.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadBox.classList.add('drag-over');
        });
        uploadBox.addEventListener('dragleave', (e) => {
            e.preventDefault();
            uploadBox.classList.remove('drag-over');
        });
        uploadBox.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadBox.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                handleFile(file);
            } else {
                showToast('Please drop an image file', 'error');
            }
        });

        const handleFile = async (file) => {
            if (!file) return;
            State.tempUploadMime = file.type;
            const rawBase64 = await new Promise((res, rej) => {
                const r = new FileReader();
                r.onload = () => res(r.result);
                r.onerror = rej;
                r.readAsDataURL(file);
            });
            const cropRect = await CropTool.open(rawBase64);
            if (!cropRect) { this.resetUploadForm(); return; }
            const cropped = await cropImage(rawBase64, cropRect);
            State.tempUploadBase64 = await compressImage(cropped);
            document.getElementById('upload-preview').src = State.tempUploadBase64;
            document.getElementById('upload-preview-container').classList.remove('hidden');
            this.setUploadState('loading');
            try {
                const items = await Gemini.autoTagClothingItem(State.tempUploadBase64, State.tempUploadMime);
                this.renderDetectedItems(items?.[0] || FALLBACK_ITEM);
            } catch {
                showToast('Auto-tagging failed. Please fill details manually.', 'error');
                this.renderDetectedItems(FALLBACK_ITEM);
                this.showRetryTagButton();
            }
            this.setUploadState('ready');
        };

        cameraInput.addEventListener('change', (e) => handleFile(e.target.files[0]));
        galleryInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

        clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.resetUploadForm(); });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (this._editMode) return; // Edit mode handles its own submission
            if (!State.tempUploadBase64) { showToast('Upload a photo first', 'error'); return; }
            try {
                const item = {
                    image: State.tempUploadBase64,
                    name: document.querySelector('.detect-item-name')?.value,
                    category: document.querySelector('.detect-item-category')?.value,
                    colorHex: document.querySelector('.detect-item-color')?.value,
                    colorName: document.querySelector('.detect-item-color-name')?.value,
                    style: document.querySelector('.detect-item-style')?.value,
                    season: document.querySelector('.detect-item-season')?.value,
                    notes: document.querySelector('.detect-item-notes')?.value || '',
                    createdAt: new Date().toISOString()
                };
                item.id = await DB.addItem(item);
                State.wardrobe.push(item);
                showToast('Added to your Wardrobe!', 'success');
                this.resetUploadForm();
                this.switchView('view-wardrobe');
            } catch (err) {
                showToast('Failed to save: ' + err, 'error');
            }
        });
    },

    setUploadState(state) {
        const z = document.querySelector('.upload-content');
        const s = document.getElementById('scanner-line');
        const st = document.getElementById('tagging-status');
        const f = document.getElementById('clothing-form');
        if (state === 'loading') { z.classList.add('hidden'); s.classList.add('scanning'); st.classList.remove('hidden'); f.classList.add('hidden'); }
        else if (state === 'ready') { s.classList.remove('scanning'); st.classList.add('hidden'); f.classList.remove('hidden'); }
    },

    resetUploadForm() {
        document.getElementById('camera-input').value = '';
        document.getElementById('gallery-input').value = '';
        document.getElementById('upload-preview').src = '';
        document.getElementById('upload-preview-container').classList.add('hidden');
        document.querySelector('.upload-content').classList.remove('hidden');
        document.getElementById('scanner-line').classList.remove('scanning');
        document.getElementById('tagging-status').classList.add('hidden');
        document.getElementById('clothing-form').classList.add('hidden');
        document.getElementById('detected-items-container').innerHTML = '';
        document.getElementById('clothing-form').reset();
        State.tempUploadBase64 = null;
        State.tempUploadMime = null;
    },

    showRetryTagButton() {
        const container = document.getElementById('detected-items-container');
        const existing = container.querySelector('.btn-retry-tag');
        if (existing) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-secondary btn-block btn-retry-tag';
        btn.textContent = 'Retry AI Tagging';
        btn.style.marginBottom = '10px';
        btn.addEventListener('click', async () => {
            if (!State.tempUploadBase64) return;
            btn.disabled = true;
            btn.textContent = 'Retrying...';
            try {
                const items = await Gemini.autoTagClothingItem(State.tempUploadBase64, State.tempUploadMime);
                this.renderDetectedItems(items?.[0] || FALLBACK_ITEM);
                showToast('AI tagging successful!', 'success');
            } catch {
                showToast('Retry failed. Fill details manually.', 'error');
                btn.disabled = false;
                btn.textContent = 'Retry AI Tagging';
            }
        });
        container.insertBefore(btn, container.firstChild);
    },

    renderDetectedItems(item) {
        const container = document.getElementById('detected-items-container');
        container.innerHTML = `
            <div class="form-group">
                <label>Item Name</label>
                <input type="text" class="detect-item-name" value="${escapeHtml(item.name || '')}" placeholder="e.g. Navy Blue Jeans" required>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Category</label>
                    <select class="detect-item-category" required>${opts(CATEGORIES, CAT_LABELS, item.category)}</select>
                </div>
                <div class="form-group">
                    <label>Color Swatch</label>
                    <div class="color-picker-wrapper">
                        <input type="color" class="detect-item-color" value="${escapeHtml(item.colorHex || '#3b82f6')}">
                        <input type="text" class="detect-item-color-name" value="${escapeHtml(item.colorName || '')}" placeholder="e.g. Tan Brown" required>
                    </div>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Style</label>
                    <select class="detect-item-style">${opts(STYLES, STYLE_LABELS, item.style)}</select>
                </div>
                <div class="form-group">
                    <label>Best For Weather</label>
                    <select class="detect-item-season">${opts(SEASONS, SEASON_LABELS, item.season)}</select>
                </div>
            </div>
            <div class="form-group">
                <label>Notes (Optional)</label>
                <input type="text" class="detect-item-notes" value="${escapeHtml(item.notes || '')}" placeholder="e.g. Slim fit cotton">
            </div>`;
    },

    setupChat() {
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('btn-send-chat');
        input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
        // Periodically update relative timestamps
        setInterval(() => {
            document.querySelectorAll('.message-time[data-timestamp]').forEach(el => {
                const ts = el.getAttribute('data-timestamp');
                if (ts) el.textContent = formatRelativeTime(new Date(ts));
            });
        }, 30000);
        // Restore saved chat history into UI
        if (State.chatHistory.length > 0) {
            // Remove hardcoded welcome message since we have history
            const welcomeMsg = document.querySelector('#chat-messages .message');
            if (welcomeMsg) welcomeMsg.remove();
            for (const msg of State.chatHistory) {
                const sender = msg.role === 'user' ? 'user' : 'assistant';
                const displayText = sender === 'assistant'
                    ? msg.text.replace(/\[IDs:.*?\]/gi, '').trim()
                    : msg.text;
                const content = sender === 'assistant'
                    ? displayText.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>')
                    : escapeHtml(displayText);
                const bubble = this.renderMessage(content, sender, msg.time || null);
                // Re-generate outfit composites for assistant messages
                if (sender === 'assistant' && /\[IDs:/i.test(msg.text)) {
                    this.renderCompositesFromResponse(msg.text, bubble);
                }
            }
        }
        const handleSend = async () => {
            const query = input.value.trim();
            if (!query) return;
            sendBtn.disabled = true;
            this.renderMessage(query, 'user');
            State.chatHistory.push({ role: 'user', text: query, time: new Date().toISOString() });
            saveChatHistory();
            input.value = '';
            input.style.height = 'auto';
            input.focus();
            const typing = this.renderMessage('<div class="spinner" style="width:16px;height:16px;border-width:2px"></div> Analyzing wardrobe...', 'assistant');
            try {
                let extra = null;
                if (State.cavemanMode) extra = "Respond in a primitive caveman style, using short sentences and simple words. Use no modern slang.";
                const response = await Gemini.suggestOutfit(query, extra);
                typing.remove();
                const html = response.replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>');
                const bubble = this.renderMessage(html, 'assistant');
                // Store raw response (with IDs) so composites can be re-generated on restore
                State.chatHistory.push({ role: 'model', text: response, time: new Date().toISOString() });
                saveChatHistory();
                await this.renderCompositesFromResponse(response, bubble);
            } catch (err) {
                typing.remove();
                this.renderMessage(`Error: ${err.message}`, 'assistant');
            } finally {
                sendBtn.disabled = false;
            }
        };
        sendBtn.addEventListener('click', handleSend);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });
        // Weather button
        document.getElementById('btn-weather').addEventListener('click', async () => {
            const weatherBtn = document.getElementById('btn-weather');
            weatherBtn.disabled = true;
            try {
                const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 10000 }));
                const { latitude, longitude } = pos.coords;
                const resp = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m`);
                const data = await resp.json();
                const cur = data.current;
                const codes = { 0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Foggy', 48: 'Icy fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers', 95: 'Thunderstorm' };
                const desc = codes[cur.weather_code] || 'Unknown';
                const weatherText = `Current weather: ${cur.temperature_2m}°C, ${desc}, wind ${cur.wind_speed_10m} km/h, humidity ${cur.relative_humidity_2m}%. `;
                input.value = weatherText + input.value;
                input.focus();
                showToast('Weather added!', 'success');
            } catch (err) {
                showToast('Could not get weather. Allow location access.', 'error');
            }
            weatherBtn.disabled = false;
        });
        // iOS keyboard fix: reposition input bar when virtual keyboard opens
        if (window.visualViewport) {
            const chatInputBar = document.querySelector('.chat-input-bar');
            window.visualViewport.addEventListener('resize', () => {
                const offset = window.innerHeight - window.visualViewport.height;
                chatInputBar.style.transform = offset > 0 ? `translateY(-${offset}px)` : '';
            });
        }
    },

    renderMessage(html, sender, timestamp = null) {
        const feed = document.getElementById('chat-messages');
        const msg = document.createElement('div');
        msg.className = `message ${sender}`;
        const time = timestamp ? formatRelativeTime(new Date(timestamp)) : 'Just now';
        msg.innerHTML = `<div class="message-bubble">${html}</div><span class="message-time" data-timestamp="${timestamp || new Date().toISOString()}">${time}</span>`;
        feed.appendChild(msg);
        feed.scrollTop = feed.scrollHeight;
        return msg;
    },

    setupGapAnalysis() {
        const btn = document.getElementById('btn-run-analysis');
        const container = document.getElementById('analysis-results');
        btn.addEventListener('click', async () => {
            if (!State.apiKey) { showToast('Add a Gemini API Key in Settings first', 'error'); return; }
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner" style="width:14px;height:14px;border-width:2px;margin-right:8px;display:inline-block"></div> Running AI Analysis...';
            container.classList.add('hidden');
            try {
                const results = await Gemini.analyzeWardrobeGaps();
                container.innerHTML = '';
                if (!Array.isArray(results) || results.length === 0) container.innerHTML = '<p style="text-align:center;padding:20px;color:var(--text-secondary)">Your collection seems well balanced! No significant gaps found.</p>';
                else results.forEach(r => {
                    const c = document.createElement('div');
                    c.className = 'gap-recommendation-card';
                    c.innerHTML = `<span class="gap-card-priority ${escapeHtml(r.priority)}">${escapeHtml(r.priority)} Priority</span><div class="gap-card-category">${escapeHtml(r.category)}</div><div class="gap-card-title">${escapeHtml(r.title)}</div><div class="gap-card-reason">${escapeHtml(r.reason)}</div>`;
                    container.appendChild(c);
                });
                container.classList.remove('hidden');
            } catch (err) { showToast('Analysis failed: ' + err.message, 'error'); }
            finally { btn.disabled = false; btn.innerHTML = '<span>Analyze Wardrobe Gaps</span>'; }
        });
    },

    setupSettings() {
        const input = document.getElementById('api-key-input');
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            input.type = input.type === 'password' ? 'text' : 'password';
        });
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            State.apiKey = input.value.trim();
            localStorage.setItem('dripchat_api_key', State.apiKey);
            this.updateConnectionStatus();
            showToast('Settings saved!', 'success');
        });
        const cave = document.getElementById('caveman-checkbox');
        if (cave) cave.addEventListener('change', (e) => {
            State.cavemanMode = e.target.checked;
            localStorage.setItem('dripchat_caveman', State.cavemanMode);
        });
        document.getElementById('btn-export-wardrobe').addEventListener('click', () => {
            if (State.wardrobe.length === 0) { showToast('Your wardrobe is empty. Add items first.', 'error'); return; }
            const blob = new Blob([JSON.stringify({ version: 1, items: State.wardrobe })], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `DripChat_Backup_${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(a.href);
        });
        const importInput = document.getElementById('import-file-input');
        document.getElementById('btn-import-trigger').addEventListener('click', () => importInput.click());
        importInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                if (!data.items?.length) throw new Error("Invalid backup JSON format.");
                if (!await showConfirm(`Importing backup will add ${data.items.length} clothes to your current device. Continue?`)) return;
                let skipped = 0;
                let duplicates = 0;
                for (const item of data.items) {
                    if (!item.image || typeof item.image !== 'string' ||
                        !item.name || typeof item.name !== 'string' ||
                        !item.category || typeof item.category !== 'string') {
                        skipped++;
                        continue;
                    }
                    // Deduplication: check if item with same name + category + colorHex already exists
                    const isDuplicate = State.wardrobe.some(w =>
                        w.name === item.name && w.category === item.category && w.colorHex === (item.colorHex || '#3b82f6')
                    );
                    if (isDuplicate) { duplicates++; continue; }
                    const clean = { image: item.image, name: item.name, category: item.category, colorHex: item.colorHex || '#3b82f6', colorName: item.colorName || '', style: item.style || 'casual', season: item.season || 'all', notes: item.notes || '', createdAt: item.createdAt || new Date().toISOString() };
                    clean.id = await DB.addItem(clean);
                    State.wardrobe.push(clean);
                }
                const msgs = [];
                if (duplicates > 0) msgs.push(`${duplicates} duplicate${duplicates > 1 ? 's' : ''} skipped`);
                if (skipped > 0) msgs.push(`${skipped} invalid skipped`);
                showToast(msgs.length > 0 ? `Backup imported! (${msgs.join(', ')})` : 'Backup imported!', 'success');
                importInput.value = '';
                this.renderWardrobe();
                this.renderStorageStats();
            } catch (err) { showToast('Import failed: ' + err.message, 'error'); }
        });
        document.getElementById('btn-reset-db').addEventListener('click', async () => {
            if (!await showConfirm("WARNING: This will permanently delete your entire wardrobe. Are you sure?")) return;
            await DB.clearAll();
            State.wardrobe = [];
            this.renderWardrobe();
            this.renderStorageStats();
            showToast('Database reset.', 'success');
        });
        document.getElementById('btn-clear-chat').addEventListener('click', async () => {
            if (!await showConfirm("Clear all chat history?")) return;
            State.chatHistory = [];
            localStorage.removeItem('dripchat_chat_history');
            const feed = document.getElementById('chat-messages');
            feed.querySelectorAll('.message').forEach((el, i) => { if (i > 0) el.remove(); });
            showToast('Chat history cleared.', 'success');
        });
    },

    updateConnectionStatus() {
        const dot = document.getElementById('connection-indicator');
        if (State.apiKey) {
            dot.classList.add('hidden');
        } else {
            dot.classList.remove('hidden');
            dot.className = 'status-dot disconnected';
            dot.title = 'Gemini API Key Required';
        }
    },

    renderStorageStats() {
        const count = State.wardrobe.length;
        document.getElementById('stat-item-count').innerText = `${count} items`;
        document.getElementById('stat-storage-size').innerText = `${calculateFormatSize(State.wardrobe)} MB`;
        document.getElementById('stats-total').textContent = count;
        // Category & style breakdown
        const catCounts = {};
        const styleCounts = {};
        const colors = [];
        for (const item of State.wardrobe) {
            catCounts[item.category] = (catCounts[item.category] || 0) + 1;
            styleCounts[item.style] = (styleCounts[item.style] || 0) + 1;
            if (item.colorHex && !colors.includes(item.colorHex)) colors.push(item.colorHex);
        }
        document.getElementById('stats-categories').innerHTML = Object.entries(catCounts).map(([k, v]) => `<span class="stats-chip">${escapeHtml(CAT_LABELS[k] || k)}<strong>${v}</strong></span>`).join('');
        document.getElementById('stats-styles').innerHTML = Object.entries(styleCounts).map(([k, v]) => `<span class="stats-chip">${escapeHtml(STYLE_LABELS[k] || k)}<strong>${v}</strong></span>`).join('');
        document.getElementById('stats-colors').innerHTML = colors.slice(0, 20).map(c => `<div class="stats-color-dot" style="background:${escapeHtml(c)}" title="${escapeHtml(c)}"></div>`).join('');
    },

    renderSavedLooks() {
        const grid = document.getElementById('saved-looks-grid');
        const empty = document.getElementById('saved-looks-empty');
        grid.querySelectorAll('.saved-look-card').forEach(el => el.remove());
        if (State.savedLooks.length === 0) { empty.classList.remove('hidden'); return; }
        empty.classList.add('hidden');
        State.savedLooks.slice().reverse().forEach((look, idx) => {
            const card = document.createElement('div');
            card.className = 'saved-look-card';
            card.innerHTML = `<img src="${look.image}" alt="Saved look"><div class="look-meta">${escapeHtml(look.items)}</div><button class="btn-remove-look" aria-label="Remove look">&times;</button>`;
            card.querySelector('.btn-remove-look').addEventListener('click', () => {
                const realIdx = State.savedLooks.length - 1 - idx;
                State.savedLooks.splice(realIdx, 1);
                try { localStorage.setItem('dripchat_saved_looks', JSON.stringify(State.savedLooks)); } catch {}
                this.renderSavedLooks();
                showToast('Look removed.', 'success');
            });
            grid.appendChild(card);
        });
    },

    async renderCompositesFromResponse(response, bubbleEl) {
        const idBlockRegex = /\[IDs:\s*(\d+(?:\s*,\s*\d+)*)\]/g;
        const lookItemIds = [];
        let m;
        while ((m = idBlockRegex.exec(response)) !== null) lookItemIds.push(m[1].split(',').map(s => parseInt(s.trim())));
        const idRegex = /(?:\[ID:\s*|ID:\s*|id:\s*)(\d+)/gi;
        const matchedIds = new Set();
        while ((m = idRegex.exec(response)) !== null) matchedIds.add(parseInt(m[1], 10));
        const lower = response.toLowerCase();
        const sets = [];
        if (lookItemIds.length > 0) {
            for (const ids of lookItemIds) {
                const items = ids.map(id => State.wardrobe.find(w => w.id === id)).filter(Boolean);
                if (items.length > 0) sets.push(items);
            }
        } else {
            const items = State.wardrobe.filter(item =>
                matchedIds.has(item.id) ||
                (item.name.length > 2 && lower.includes(item.name.toLowerCase()) && item.image)
            );
            const deduped = [];
            const seen = new Set();
            for (const i of items) { if (!seen.has(i.id)) { seen.add(i.id); deduped.push(i); } }
            if (deduped.length > 0) sets.push(deduped);
        }
        for (const look of sets) await this.generateLookComposite(look, bubbleEl);
    },

    async generateLookComposite(items, bubbleEl) {
        const load = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
        try {
            const imgs = await Promise.all(items.map(i => load(i.image)));
            const CAT_ORDER = ['outerwear', 'tops', 'bottoms', 'shoes', 'accessories'];
            const sorted = items.map((item, idx) => ({ item, img: imgs[idx] }))
                .sort((a, b) => (CAT_ORDER.indexOf(a.item.category) === -1 ? 99 : CAT_ORDER.indexOf(a.item.category)) - (CAT_ORDER.indexOf(b.item.category) === -1 ? 99 : CAT_ORDER.indexOf(b.item.category)));
            const W = 420, GAP = 10, HDR = 46, FTR = 36, RAD = 14, LH = 26;
            const HEIGHTS = { outerwear: 190, tops: 190, bottoms: 210, shoes: 150, accessories: 130 };
            const DEF = 170;
            const total = sorted.reduce((t, { item }) => t + (HEIGHTS[item.category] || DEF) + LH + GAP, 0);
            const H = HDR + GAP + total + FTR;
            const IW = W - 40;
            const c = document.createElement('canvas');
            c.width = W; c.height = H;
            const ctx = c.getContext('2d');
            ctx.fillStyle = '#0a0d14';
            ctx.fillRect(0, 0, W, H);
            const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, H * 0.7);
            g.addColorStop(0, 'rgba(245,158,11,0.1)'); g.addColorStop(0.5, 'rgba(245,158,11,0.04)'); g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            const hg = ctx.createLinearGradient(0, 0, W, 0);
            hg.addColorStop(0, '#f59e0b'); hg.addColorStop(1, '#d97706');
            ctx.fillStyle = hg;
            ctx.beginPath(); ctx.roundRect(0, 0, W, HDR, [0, 0, 0, 0]); ctx.fill();
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.beginPath(); ctx.arc(22, HDR / 2, 9, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 11px system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('D', 22, HDR / 2);
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 15px system-ui, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('Today\'s Look', 42, HDR / 2);
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            const badge = `${sorted.length} item${sorted.length > 1 ? 's' : ''}`;
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.textAlign = 'right';
            const bw = ctx.measureText(badge).width + 16;
            ctx.beginPath(); ctx.roundRect(W - 14 - bw, (HDR - 18) / 2, bw, 18, 9); ctx.fill();
            ctx.fillStyle = '#fff';
            ctx.fillText(badge, W - 22, HDR / 2);
            let y = HDR + GAP;
            for (const { item, img } of sorted) {
                const h = HEIGHTS[item.category] || DEF;
                ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 6;
                ctx.fillStyle = 'rgba(255,255,255,0.04)';
                ctx.beginPath(); ctx.roundRect(20, y, IW, h + LH, RAD); ctx.fill();
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
                ctx.save();
                ctx.beginPath(); ctx.roundRect(20, y, IW, h, RAD); ctx.clip();
                const s = Math.max(IW / img.width, h / img.height);
                ctx.drawImage(img, 20 + (IW - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s);
                const f = ctx.createLinearGradient(0, y + h - 40, 0, y + h);
                f.addColorStop(0, 'transparent'); f.addColorStop(1, 'rgba(0,0,0,0.45)');
                ctx.fillStyle = f;
                ctx.fillRect(20, y + h - 40, IW, 40);
                ctx.restore();
                ctx.strokeStyle = 'rgba(255,255,255,0.09)'; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.roundRect(20, y, IW, h, RAD); ctx.stroke();
                const cl = item.category.charAt(0).toUpperCase() + item.category.slice(1);
                ctx.font = '600 10px system-ui, sans-serif';
                const cw = ctx.measureText(cl).width + 14;
                ctx.fillStyle = 'rgba(0,0,0,0.55)';
                ctx.beginPath(); ctx.roundRect(30, y + 10, cw, 20, 10); ctx.fill();
                ctx.fillStyle = '#fde68a';
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                ctx.fillText(cl, 37, y + 20);
                const ly = y + h;
                if (item.colorHex) {
                    ctx.fillStyle = item.colorHex;
                    ctx.beginPath(); ctx.arc(34, ly + LH / 2, 5, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.arc(34, ly + LH / 2, 5, 0, Math.PI * 2); ctx.stroke();
                }
                ctx.fillStyle = '#e2e8f0';
                ctx.font = '500 12px system-ui, sans-serif';
                ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
                let label = item.name;
                if (label.length > 32) label = label.slice(0, 31) + '...';
                ctx.fillText(label, 46, ly + LH / 2);
                if (item.colorName) {
                    ctx.fillStyle = 'rgba(255,255,255,0.35)';
                    ctx.font = '400 10px system-ui, sans-serif';
                    ctx.textAlign = 'right';
                    let cn = item.colorName;
                    if (cn.length > 20) cn = cn.slice(0, 19) + '...';
                    ctx.fillText(cn, 20 + IW - 10, ly + LH / 2);
                }
                y += h + LH + GAP;
            }
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            ctx.font = '400 11px system-ui, sans-serif';
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('Generated by DripChat \u00B7 Your AI Stylist', W / 2, H - FTR / 2);
            const bubble = bubbleEl.querySelector('.message-bubble');
            if (bubble) {
                const lookDataUrl = c.toDataURL('image/png');
                const imgEl = document.createElement('img');
                imgEl.src = lookDataUrl;
                imgEl.alt = 'Outfit look preview';
                imgEl.style.cssText = 'max-width:100%;display:block;border-radius:14px;margin-top:14px';
                bubble.appendChild(imgEl);
                // Save Look button
                const saveBtn = document.createElement('button');
                saveBtn.className = 'btn btn-secondary btn-save-look';
                saveBtn.textContent = 'Save Look';
                saveBtn.style.cssText = 'margin-top:8px;padding:6px 12px;font-size:0.75rem;width:auto;display:inline-flex';
                saveBtn.addEventListener('click', () => {
                    State.savedLooks.push({ image: lookDataUrl, items: items.map(i => i.name).join(', '), savedAt: new Date().toISOString() });
                    try { localStorage.setItem('dripchat_saved_looks', JSON.stringify(State.savedLooks.slice(-20))); } catch {}
                    showToast('Look saved!', 'success');
                    saveBtn.disabled = true;
                    saveBtn.textContent = 'Saved';
                });
                bubble.appendChild(saveBtn);
            }
        } catch (e) {
            console.warn('Look composite generation failed:', e);
        }
    },

    setupSwipeNav() {
        const viewOrder = ['view-wardrobe', 'view-chat', 'view-add', 'view-shop', 'view-settings'];
        const main = document.getElementById('app-main');
        let startX = 0, startY = 0, tracking = false;
        main.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            tracking = true;
        }, { passive: true });
        main.addEventListener('touchend', (e) => {
            if (!tracking) return;
            tracking = false;
            const dx = e.changedTouches[0].clientX - startX;
            const dy = e.changedTouches[0].clientY - startY;
            // Only trigger if horizontal swipe is dominant and > 80px
            if (Math.abs(dx) < 80 || Math.abs(dy) > Math.abs(dx) * 0.7) return;
            const current = document.querySelector('.app-view.active');
            if (!current) return;
            const idx = viewOrder.indexOf(current.id);
            if (idx === -1) return;
            if (dx < 0 && idx < viewOrder.length - 1) {
                this.switchView(viewOrder[idx + 1]);
            } else if (dx > 0 && idx > 0) {
                this.switchView(viewOrder[idx - 1]);
            }
        }, { passive: true });
    },

    setupRipple() {
        document.querySelectorAll('.btn').forEach(btn => {
            btn.addEventListener('click', function(e) {
                const rect = this.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const ripple = document.createElement('span');
                ripple.className = 'ripple';
                ripple.style.cssText = `left:${x}px;top:${y}px`;
                this.appendChild(ripple);
                setTimeout(() => ripple.remove(), 600);
            });
        });
    }
};

window.addEventListener('DOMContentLoaded', async () => {
    State.apiKey = localStorage.getItem('dripchat_api_key') || '';
    document.getElementById('api-key-input').value = State.apiKey;
    State.cavemanMode = localStorage.getItem('dripchat_caveman') === 'true';
    const ct = document.getElementById('caveman-checkbox');
    if (ct) ct.checked = State.cavemanMode;
    // Restore chat history from localStorage
    try {
        const savedChat = localStorage.getItem('dripchat_chat_history');
        if (savedChat) State.chatHistory = JSON.parse(savedChat);
    } catch { /* ignore corrupted history */ }
    try {
        const savedLooks = localStorage.getItem('dripchat_saved_looks');
        if (savedLooks) State.savedLooks = JSON.parse(savedLooks);
    } catch { /* ignore */ }
    try {
        await DB.init();
        State.wardrobe = await DB.getAllItems();
    } catch (err) { alert("Local database initialization failed: " + err); }
    TelegramIntegration.init();
    UI.init();
    UI.renderWardrobe();
    UI.renderStorageStats();
    // Hide loader and show app
    const loader = document.getElementById('app-loader');
    const container = document.getElementById('app-container');
    container.classList.remove('app-hidden');
    container.classList.add('app-visible');
    if (loader) { loader.classList.add('fade-out'); setTimeout(() => loader.remove(), 300); }
    // Register service worker for PWA
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
});
