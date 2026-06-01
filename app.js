const State = {
    apiKey: '', currentView: 'view-wardrobe', wardrobe: [],
    tgWebApp: null, tempUploadBase64: null, tempUploadMime: null, cavemanMode: false
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
    deleteItem: (id) => idb('delete', id),
    clearAll: () => idb('clear')
};

function compressImage(file, maxDimension = 800) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const img = new Image();
            img.src = e.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > h) { if (w > maxDimension) { h = Math.round(h * maxDimension / w); w = maxDimension; } }
                else { if (h > maxDimension) { w = Math.round(w * maxDimension / h); h = maxDimension; } }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.75));
            };
            img.onerror = () => reject("Invalid image file.");
        };
        reader.onerror = () => reject("File reading failed.");
    });
}

function calculateFormatSize(items) {
    const bytes = items.reduce((t, i) => {
        if (i.image) t += i.image.length * 0.75;
        return t + JSON.stringify(i).length;
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
            resolve(canvas.toDataURL('image/jpeg', 0.75));
        };
        img.onerror = () => reject("Image crop failed.");
        img.src = base64Image;
    });
}

const TelegramIntegration = {
    init() {
        if (window.Telegram?.WebApp) {
            State.tgWebApp = window.Telegram.WebApp;
            State.tgWebApp.ready();
            State.tgWebApp.expand();
            document.body.classList.add('in-telegram');
            if (State.tgWebApp.themeParams?.bg_color)
                document.documentElement.style.setProperty('--bg-color', State.tgWebApp.themeParams.bg_color);
        }
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
Each object: {"name":"short name","category":"tops|bottoms|outerwear|shoes|accessories","colorName":"primary+accent colors","colorHex":"#hex","style":"casual|formal|athletic|smart-casual|streetwear","season":"all|hot|cold|mild|rainy","notes":"color layout, textures, fit description for stylist","bbox":{"x":0.1,"y":0.05,"w":0.35,"h":0.6}}
bbox = decimal fraction of image (0-1), x,y=top-left corner, w,h=width&height. Tight crop with minimal padding. Include bbox for every item.` },
                { inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Image.split(',')[1] } }
            ]}]
        };
        return JSON.parse(await this.callAPI(payload));
    },

    async suggestOutfit(userInput, extraInstruction = null) {
        const list = State.wardrobe.map(i => `- [ID:${i.id}] ${i.name} (${i.category}, ${i.colorName}, ${i.style}, ${i.season})`).join('\n');
        let system = `You are DripChat, a stylish wardrobe assistant. User's wardrobe:\n${list || 'Empty. Ask them to add clothes first.'}\n\nRules: 1) ONLY recommend items EXACTLY from wardrobe above. 2) Suggest 2-3 outfits for their scenario. 3) Brief, fashion-forward, bold headings, smartphone-friendly. 4) After EACH look, on a new line put: [IDs: {comma-separated item IDs}]. This ID line is internal only.`;
        if (extraInstruction) system = `${extraInstruction}\n\n${system}`;
        const msgs = Array.from(document.querySelectorAll('.message')).slice(-6).map(m => ({
            role: m.classList.contains('user') ? 'user' : 'model',
            parts: [{ text: m.querySelector('.message-bubble').innerText }]
        }));
        msgs.push({ role: 'user', parts: [{ text: userInput }] });
        return this.callAPI({ contents: msgs }, system);
    },

    async analyzeWardrobeGaps() {
        const list = State.wardrobe.map(i => `- ${i.name} (${i.category}, ${i.colorName}, ${i.style}, ${i.season})`).join('\n');
        const system = `Analyze wardrobe inventory and recommend 3 strategic purchases to maximize outfit versatility. Return JSON array strictly:
[{"title":"specific item to buy","category":"shoes|tops|bottoms|outerwear|accessories","priority":"high|medium","reason":"why it fills a gap"}]
Inventory:\n${list || 'EMPTY'}`;
        return JSON.parse(await this.callAPI({ jsonMode: true, contents: [{ parts: [{ text: 'Analyze my wardrobe gaps.' }] }] }, system));
    }
};

const CropTool = {
    img: null, wrapper: null, box: null, overlay: null,
    imgW: 0, imgH: 0, viewW: 0, viewH: 0, offsetX: 0, offsetY: 0,
    dragging: false, mode: 'move', startX: 0, startY: 0,
    boxStart: {},
    resolve: null,

    open(base64) {
        return new Promise((resolve) => {
            this.resolve = resolve;
            document.getElementById('crop-modal').classList.remove('hidden');
            const img = document.getElementById('crop-image');
            img.src = base64;
            img.onload = () => {
                this.img = img;
                this.wrapper = document.getElementById('crop-wrapper');
                this.box = document.getElementById('crop-box');
                this.overlay = document.getElementById('crop-overlay');
                this.calcDimensions();
                this.initBox();
                this.bindEvents();
            };
        });
    },

    close() {
        document.getElementById('crop-modal').classList.add('hidden');
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
        this.imgW = this.img.naturalWidth;
        this.imgH = this.img.naturalHeight;
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
        this.box.addEventListener('mousedown', this.onPointerDown);
        this.box.addEventListener('touchstart', this.onPointerDown, { passive: false });
        document.addEventListener('mousemove', this.onPointerMove);
        document.addEventListener('mouseup', this.onPointerUp);
        document.addEventListener('touchmove', this.onPointerMove, { passive: false });
        document.addEventListener('touchend', this.onPointerUp);
        document.getElementById('btn-crop-confirm').addEventListener('click', () => this.confirm());
        document.getElementById('btn-crop-cancel').addEventListener('click', () => this.cancel());
    },

    unbindEvents() {
        this.box?.removeEventListener('mousedown', this.onPointerDown);
        this.box?.removeEventListener('touchstart', this.onPointerDown);
        document.removeEventListener('mousemove', this.onPointerMove);
        document.removeEventListener('mouseup', this.onPointerUp);
        document.removeEventListener('touchmove', this.onPointerMove);
        document.removeEventListener('touchend', this.onPointerUp);
    },

    getPos(e) {
        const p = e.touches ? e.touches[0] : e;
        return { x: p.clientX, y: p.clientY };
    },

    handlePointerDown(e) {
        e.preventDefault();
        const t = e.target;
        if (t.classList.contains('crop-handle') || t.closest('.crop-handle')) {
            const handle = t.closest('.crop-handle');
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
    },

    setupNavigation() {
        document.querySelectorAll('.nav-tab').forEach(t => t.addEventListener('click', () => this.switchView(t.getAttribute('data-target'))));
        document.querySelector('.btn-tab-trigger')?.addEventListener('click', (e) => this.switchView(e.target.getAttribute('data-target')));
    },

    switchView(viewId) {
        document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
        document.getElementById(viewId).classList.add('active');
        document.querySelectorAll('.nav-tab').forEach(t => {
            t.classList.toggle('active', t.getAttribute('data-target') === viewId);
        });
        State.currentView = viewId;
        if (viewId === 'view-wardrobe') this.renderWardrobe();
        else if (viewId === 'view-settings') this.renderStorageStats();
    },

    setupWardrobeViews() {
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                this.renderWardrobe(chip.getAttribute('data-category'));
            });
        });
        document.getElementById('btn-close-modal').addEventListener('click', () => {
            document.getElementById('item-modal').classList.add('hidden');
        });
    },

    renderWardrobe(filter = 'all') {
        const grid = document.getElementById('wardrobe-grid');
        const empty = document.getElementById('wardrobe-empty');
        grid.querySelectorAll('.item-card').forEach(el => el.remove());
        const items = filter === 'all' ? State.wardrobe : State.wardrobe.filter(i => i.category === filter);
        if (items.length === 0) {
            empty.classList.remove('hidden');
            empty.querySelector('h3').innerText = filter === 'all' ? 'Your wardrobe is empty' : 'No items in this category';
            empty.querySelector('p').innerText = filter === 'all' ? 'Upload photos of your clothes to get AI outfit suggestions!' : `You haven't uploaded any clothing items under "${filter}" yet.`;
            return;
        }
        empty.classList.add('hidden');
        items.forEach(item => {
            const card = document.createElement('div');
            card.className = 'item-card';
            card.innerHTML = `<div class="card-img-wrapper"><img src="${item.image}" alt="${item.name}" loading="lazy"><span class="card-badge">${item.category}</span></div><div class="card-info"><h4>${item.name}</h4><div class="card-meta"><span>${item.style}</span><div class="card-color-indicator" style="background:${item.colorHex}" title="${item.colorName}"></div></div></div>`;
            card.addEventListener('click', () => this.showItemDetails(item));
            grid.appendChild(card);
        });
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
        const del = document.getElementById('btn-delete-item');
        const clone = del.cloneNode(true);
        del.parentNode.replaceChild(clone, del);
        clone.addEventListener('click', async () => {
            if (!confirm(`Delete "${item.name}"?`)) return;
            await DB.deleteItem(item.id);
            State.wardrobe = State.wardrobe.filter(w => w.id !== item.id);
            modal.classList.add('hidden');
            this.renderWardrobe();
        });
        modal.classList.remove('hidden');
    },

    setupUploader() {
        const box = document.getElementById('upload-box');
        const input = document.getElementById('file-input');
        const clearBtn = document.getElementById('btn-clear-upload');
        const form = document.getElementById('clothing-form');

        box.addEventListener('click', (e) => {
            if (e.target !== clearBtn && !clearBtn.contains(e.target)) input.click();
        });

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            this.setUploadState('loading');
            const compressed = await compressImage(file);
            State.tempUploadMime = file.type;
            const cropRect = await CropTool.open(compressed);
            if (!cropRect) { this.resetUploadForm(); return; }
            State.tempUploadBase64 = await cropImage(compressed, cropRect);
            document.getElementById('upload-preview').src = State.tempUploadBase64;
            document.getElementById('upload-preview-container').classList.remove('hidden');
            this.renderDetectedItems([FALLBACK_ITEM]);
            this.setUploadState('ready');
        });

        clearBtn.addEventListener('click', (e) => { e.stopPropagation(); this.resetUploadForm(); });

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!State.tempUploadBase64) { alert("Please upload a clothing item photo first."); return; }
            const cards = document.querySelectorAll('.detected-item-card');
            if (cards.length === 0) { alert("No items in the list to save."); return; }
            try {
                for (const card of cards) {
                    const item = {
                        image: State.tempUploadBase64,
                        name: card.querySelector('.detect-item-name').value,
                        category: card.querySelector('.detect-item-category').value,
                        colorHex: card.querySelector('.detect-item-color').value,
                        colorName: card.querySelector('.detect-item-color-name').value,
                        style: card.querySelector('.detect-item-style').value,
                        season: card.querySelector('.detect-item-season').value,
                        notes: card.querySelector('.detect-item-notes').value,
                        createdAt: new Date().toISOString()
                    };
                    item.id = await DB.addItem(item);
                    State.wardrobe.push(item);
                }
                alert(`Successfully added ${cards.length} item${cards.length > 1 ? 's' : ''} to your Wardrobe!`);
                this.resetUploadForm();
                this.switchView('view-wardrobe');
            } catch (err) {
                alert("Failed to save clothing items: " + err);
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
        document.getElementById('file-input').value = '';
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

    renderDetectedItems(items) {
        const container = document.getElementById('detected-items-container');
        container.innerHTML = '';
        items.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'detected-item-card';
            card.innerHTML = `
                <div class="detected-item-header">
                    <span class="detected-item-index">Item #${index + 1}</span>
                    <button type="button" class="btn-remove-detected" title="Remove this item">&times;</button>
                </div>
                <div class="form-group">
                    <label>Item Name</label>
                    <input type="text" class="detect-item-name" value="${item.name || ''}" placeholder="e.g. Navy Blue Jeans" required>
                </div>
                <div class="form-row">
                    <div class="form-group">
                        <label>Category</label>
                        <select class="detect-item-category" required>${opts(CATEGORIES, CAT_LABELS, item.category)}</select>
                    </div>
                    <div class="form-group">
                        <label>Color Swatch</label>
                        <div class="color-picker-wrapper">
                            <input type="color" class="detect-item-color" value="${item.colorHex || '#3b82f6'}">
                            <input type="text" class="detect-item-color-name" value="${item.colorName || ''}" placeholder="e.g. Tan Brown" required>
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
                    <input type="text" class="detect-item-notes" value="${item.notes || ''}" placeholder="e.g. Slim fit cotton">
                </div>`;
            card.querySelector('.btn-remove-detected').addEventListener('click', () => {
                card.remove();
                const remaining = container.querySelectorAll('.detected-item-card');
                if (remaining.length === 0) this.resetUploadForm();
                else remaining.forEach((c, idx) => c.querySelector('.detected-item-index').innerText = `Item #${idx + 1}`);
            });
            container.appendChild(card);
        });
    },

    setupChat() {
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('btn-send-chat');
        input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; });
        const handleSend = async () => {
            const query = input.value.trim();
            if (!query) return;
            this.renderMessage(query, 'user');
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
                for (const look of sets) await this.generateLookComposite(look, bubble);
            } catch (err) {
                typing.remove();
                this.renderMessage(`⚠️ Error: ${err.message}`, 'assistant');
            }
        };
        sendBtn.addEventListener('click', handleSend);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } });
    },

    renderMessage(html, sender) {
        const feed = document.getElementById('chat-messages');
        const msg = document.createElement('div');
        msg.className = `message ${sender}`;
        msg.innerHTML = `<div class="message-bubble">${html}</div><span class="message-time">Just now</span>`;
        feed.appendChild(msg);
        feed.scrollTop = feed.scrollHeight;
        return msg;
    },

    setupGapAnalysis() {
        const btn = document.getElementById('btn-run-analysis');
        const container = document.getElementById('analysis-results');
        btn.addEventListener('click', async () => {
            if (!State.apiKey) { alert("Please add a Gemini API Key in Settings to run gap analysis."); return; }
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
                    c.innerHTML = `<span class="gap-card-priority ${r.priority}">${r.priority} Priority</span><div class="gap-card-category">${r.category}</div><div class="gap-card-title">${r.title}</div><div class="gap-card-reason">${r.reason}</div>`;
                    container.appendChild(c);
                });
                container.classList.remove('hidden');
            } catch (err) { alert("Gap Analysis failed: " + err.message); }
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
            alert("Settings updated successfully!");
        });
        const cave = document.getElementById('caveman-checkbox');
        if (cave) cave.addEventListener('change', (e) => {
            State.cavemanMode = e.target.checked;
            localStorage.setItem('dripchat_caveman', State.cavemanMode);
        });
        document.getElementById('btn-export-wardrobe').addEventListener('click', () => {
            if (State.wardrobe.length === 0) { alert("Your wardrobe is empty. Add items first."); return; }
            const blob = new Blob([JSON.stringify({ version: 1, items: State.wardrobe })], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `DripChat_Backup_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
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
                if (!confirm(`Importing backup will add ${data.items.length} clothes to your current device. Continue?`)) return;
                for (const item of data.items) {
                    const clean = { image: item.image, name: item.name, category: item.category, colorHex: item.colorHex, colorName: item.colorName, style: item.style, season: item.season, notes: item.notes || '', createdAt: item.createdAt || new Date().toISOString() };
                    clean.id = await DB.addItem(clean);
                    State.wardrobe.push(clean);
                }
                alert("Backup imported successfully!");
                importInput.value = '';
                this.renderWardrobe();
                this.renderStorageStats();
            } catch (err) { alert("Import failed: " + err.message); }
        });
        document.getElementById('btn-reset-db').addEventListener('click', async () => {
            if (!confirm("WARNING: This will permanently delete your entire wardrobe. Are you sure?")) return;
            await DB.clearAll();
            State.wardrobe = [];
            this.renderWardrobe();
            this.renderStorageStats();
            alert("Database reset successful.");
        });
    },

    updateConnectionStatus() {
        const dot = document.getElementById('connection-indicator');
        if (State.apiKey) { dot.className = 'status-dot connected'; dot.title = 'Gemini API Key Configured'; }
        else { dot.className = 'status-dot disconnected'; dot.title = 'Gemini API Key Required'; }
    },

    renderStorageStats() {
        document.getElementById('stat-item-count').innerText = `${State.wardrobe.length} items`;
        document.getElementById('stat-storage-size').innerText = `${calculateFormatSize(State.wardrobe)} MB`;
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
            g.addColorStop(0, 'rgba(99,102,241,0.12)'); g.addColorStop(0.5, 'rgba(168,85,247,0.06)'); g.addColorStop(1, 'transparent');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = 'rgba(255,255,255,0.025)';
            for (let gx = 20; gx < W; gx += 24) for (let gy = HDR + 10; gy < H - FTR; gy += 24) { ctx.beginPath(); ctx.arc(gx, gy, 1, 0, Math.PI * 2); ctx.fill(); }
            const hg = ctx.createLinearGradient(0, 0, W, 0);
            hg.addColorStop(0, '#6366f1'); hg.addColorStop(1, '#a855f7');
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
                ctx.fillStyle = '#c4b5fd';
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
                const imgEl = document.createElement('img');
                imgEl.src = c.toDataURL('image/png');
                imgEl.alt = 'Outfit look preview';
                imgEl.style.cssText = 'max-width:100%;display:block;border-radius:14px;margin-top:14px';
                bubble.appendChild(imgEl);
            }
        } catch (e) {}
    }
};

window.addEventListener('DOMContentLoaded', async () => {
    State.apiKey = localStorage.getItem('dripchat_api_key') || '';
    document.getElementById('api-key-input').value = State.apiKey;
    State.cavemanMode = localStorage.getItem('dripchat_caveman') === 'true';
    const ct = document.getElementById('caveman-checkbox');
    if (ct) ct.checked = State.cavemanMode;
    try {
        await DB.init();
        State.wardrobe = await DB.getAllItems();
    } catch (err) { alert("Local database initialization failed: " + err); }
    TelegramIntegration.init();
    UI.init();
    UI.renderWardrobe();
});
