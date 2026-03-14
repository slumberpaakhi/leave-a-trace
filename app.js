import { getStroke } from 'https://cdn.jsdelivr.net/npm/perfect-freehand@1.2.0/+esm';

/**
 * Trace World: Infinite Canvas Drawing Application
 * Logic: Every trace fades out over 24 hours. Real-time sync via Pusher.
 * Features: Infinite pan/zoom, mobile-first design, 4-corner layout.
 */

const PUSHER_KEY = '9916c0c7cc39de16616c';
const PUSHER_CLUSTER = 'ap2';

class TraceApp {
    constructor() {
        // Core elements
        this.canvas = document.getElementById('trace-canvas');
        this.ctx = this.canvas.getContext('2d', { alpha: true });

        // App State
        this.isDrawing = false;
        this.isPanning = false;
        this.panOffset = { x: 0, y: 0 };
        this.lastPan = { x: 0, y: 0 };
        this.zoomScale = 1.0;

        // Settings
        this.currentColor = '#2d3436';
        this.currentSize = 8;
        this.fadeDuration = 24 * 60 * 60 * 1000; // 24 hours
        this.minZoom = 0.1;
        this.maxZoom = 10;

        // Identity
        this.user = this.loadIdentity();
        this.sessionSeed = Math.random().toString(36).substr(2, 9);

        // Data
        this.traces = [];
        this.localHistory = [];
        this.isPanMode = false;
        this.lastPinchDist = 0;

        // Real-time synchronization
        this.syncChannel = new BroadcastChannel('trace_tab_sync');
        this.setupTabSync();

        // Theme
        this.theme = localStorage.getItem('theme_v1') || 'light';
        document.body.setAttribute('data-theme', this.theme);

        // Admin
        this.isAdmin = window.location.search.includes('admin=true');
        this.isAuthenticated = false;
        this.adminPass = '';
        this.analytics = { visits: 0, clears: 0 };

        // Start
        this.init();
        this.loadWorld();
        window.appInstance = this; // For debugging
    }

    /**
     * STORAGE & IDENTITY
     */
    loadIdentity() {
        try {
            const saved = localStorage.getItem('trace_user_v2');
            if (saved && saved !== "undefined") return JSON.parse(saved);
        } catch (e) { }
        return null;
    }

    async saveIdentity() {
        const nickInput = document.getElementById('nickname-input');
        const passInput = document.getElementById('user-password-input');
        const nick = nickInput.value.trim();
        const pass = passInput.value.trim();

        if (nick.length < 2 || pass.length < 4) {
            alert('please enter both nickname and password (min 4 chars).');
            return;
        }

        try {
            const res = await fetch('/api/auth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname: nick, password: pass })
            });
            const data = await res.json();
            if (!res.ok) {
                alert(data.error || 'auth failed');
                return;
            }
            this.user = {
                ...data.user,
                avatar: this.getAvatarUrl(nick + this.sessionSeed)
            };
            localStorage.setItem('trace_user_v2', JSON.stringify(this.user));
            document.getElementById('identity-modal').classList.add('hidden');
            this.updateIdentityDisplay();
            this.setupRealtime();
        } catch (e) {
            alert('check your connection.');
        }
    }

    updateIdentityDisplay() {
        if (!this.user) return;
        const nickEl = document.getElementById('current-user-nickname');
        const avatarEl = document.getElementById('current-user-avatar');
        if (nickEl) nickEl.innerText = this.user.nickname;
        if (avatarEl) this.renderAvatar(avatarEl, this.user.avatar);
    }

    renderAvatar(container, url) {
        if (!container) return;
        container.innerHTML = `<img src="${url}" style="width:100%; height:100%; border-radius:50%; image-rendering:pixelated">`;
    }

    getAvatarUrl(seed) {
        return `https://api.dicebear.com/7.x/pixel-art/svg?seed=${encodeURIComponent(seed)}`;
    }

    updateSetupPreview(nick) {
        const seed = nick.trim() + this.sessionSeed;
        const previewEl = document.getElementById('setup-avatar-preview');
        if (previewEl) this.renderAvatar(previewEl, this.getAvatarUrl(seed));
    }

    /**
     * INITIALIZATION
     */
    init() {
        this.resize();
        this.centerView();

        // Listeners
        window.addEventListener('resize', () => this.resize());

        // Modal logic
        if (!this.user && !this.isAdmin) {
            document.getElementById('identity-modal').classList.remove('hidden');
        } else {
            this.updateIdentityDisplay();
            this.setupRealtime();
        }

        const saveBtn = document.getElementById('save-identity');
        if (saveBtn) saveBtn.onclick = () => this.saveIdentity();

        const nickInput = document.getElementById('nickname-input');
        if (nickInput) nickInput.oninput = (e) => this.updateSetupPreview(e.target.value);

        // Input Setup
        this.canvas.addEventListener('mousedown', (e) => this.onInteractionStart(e));
        window.addEventListener('mousemove', (e) => this.onInteractionMove(e));
        window.addEventListener('mouseup', () => this.onInteractionEnd());

        // Touch
        this.canvas.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                this.lastPinchDist = this.getTouchDist(e.touches);
            } else {
                const touch = e.touches[0];
                this.onInteractionStart({ clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: false });

        this.canvas.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (e.touches.length === 2) {
                const dist = this.getTouchDist(e.touches);
                const factor = dist / this.lastPinchDist;
                const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                this.handleZoom(factor, midX, midY);
                this.lastPinchDist = dist;
            } else {
                const touch = e.touches[0];
                this.onInteractionMove({ clientX: touch.clientX, clientY: touch.clientY });
            }
        }, { passive: false });

        this.canvas.addEventListener('touchend', () => {
            this.onInteractionEnd();
            this.lastPinchDist = 0;
        });

        // Wheel Zoom
        window.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const factor = e.deltaY > 0 ? 0.9 : 1.1;
                this.handleZoom(factor, e.clientX, e.clientY);
            }
        }, { passive: false });

        // Toolbar
        document.getElementById('undo-btn').onclick = () => this.undo();
        document.getElementById('pan-btn').onclick = () => {
            this.isPanMode = !this.isPanMode;
            document.getElementById('pan-btn').classList.toggle('active', this.isPanMode);
            this.setCursor(this.isPanMode ? 'grab' : 'crosshair');
        };
        document.getElementById('center-btn').onclick = () => this.centerView();
        document.getElementById('reset-btn').onclick = () => this.clearAll();
        document.getElementById('theme-toggle').onclick = () => this.toggleTheme();

        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.onclick = (e) => {
                this.currentColor = e.target.dataset.color || '#2d3436';
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.isPanMode = false;
                document.getElementById('pan-btn').classList.remove('active');
                this.setCursor('crosshair');
            };
        });

        const slider = document.getElementById('size-slider');
        if (slider) {
            slider.oninput = (e) => {
                this.currentSize = parseInt(e.target.value);
                const hint = document.getElementById('current-size-hint');
                if (hint) hint.innerText = this.currentSize;
            };
        }

        // Periodic render for fading
        setInterval(() => this.render(), 60000);
    }

    /**
     * CORE INTERACTION
     */
    onInteractionStart(e) {
        if (!this.user || this.isAdmin) return;

        if (this.isPanMode) {
            this.isPanning = true;
            this.lastPan = { x: e.clientX, y: e.clientY };
            this.setCursor('grabbing');
            return;
        }

        this.isDrawing = true;
        const pos = this.getCoord(e);
        this.currentStroke = {
            id: Math.random().toString(36).substr(2, 9),
            userId: this.user.id,
            nickname: this.user.nickname,
            avatar: this.user.avatar,
            color: this.currentColor,
            size: this.currentSize,
            timestamp: Date.now(),
            points: [[pos.x, pos.y, 0.5]]
        };
        this.traces.push(this.currentStroke);
        this.localHistory.push(this.currentStroke.id);
        this.updateStats();
        this.syncChannel.postMessage({ type: 'NEW_TRACE', payload: this.currentStroke });
    }

    onInteractionMove(e) {
        if (this.isPanning) {
            const dx = (e.clientX - this.lastPan.x) / this.zoomScale;
            const dy = (e.clientY - this.lastPan.y) / this.zoomScale;
            this.panOffset.x -= dx;
            this.panOffset.y -= dy;
            this.lastPan = { x: e.clientX, y: e.clientY };
            this.render();
            return;
        }

        const pos = this.getCoord(e);

        // Real-time cursor sync
        if (this.user) {
            const now = Date.now();
            if (!this.lastBroadcast || now - this.lastBroadcast > 50) {
                this.lastBroadcast = now;
                this.broadcastCursor(pos);
            }
        }

        if (this.isDrawing) {
            const points = this.currentStroke.points;
            const last = points[points.length - 1];
            if (Math.hypot(pos.x - last[0], pos.y - last[1]) > 2) {
                points.push([pos.x, pos.y, 0.5]);
                this.render();
            }
        } else if (window.matchMedia('(hover: hover)').matches) {
            this.checkHover(e);
        }
    }

    onInteractionEnd() {
        if (this.isPanning) {
            this.isPanning = false;
            this.setCursor(this.isPanMode ? 'grab' : 'crosshair');
            return;
        }
        if (!this.isDrawing) return;
        this.isDrawing = false;

        if (this.currentStroke) {
            this.saveStroke(this.currentStroke);
        }
    }

    /**
     * DRAWING ENGINE
     */
    render() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        const now = Date.now();

        // Filter out expired traces (local optimization)
        this.traces = this.traces.filter(t => (now - t.timestamp) < this.fadeDuration);

        // Background pan
        const bgX = -this.panOffset.x * this.zoomScale;
        const bgY = -this.panOffset.y * this.zoomScale;
        const bgSize = 1000 * this.zoomScale;
        document.body.style.backgroundPosition = `${bgX}px ${bgY}px`;
        document.body.style.backgroundSize = `${bgSize}px`;

        this.ctx.save();
        this.ctx.scale(this.zoomScale, this.zoomScale);
        this.ctx.translate(-this.panOffset.x, -this.panOffset.y);

        this.traces.forEach(stroke => {
            const alpha = Math.max(0, 1 - ((now - stroke.timestamp) / this.fadeDuration));
            this.drawStroke(stroke, alpha);
        });

        this.ctx.restore();
    }

    drawStroke(stroke, alpha = 1) {
        if (!stroke.points || stroke.points.length < 1) return;

        // Normalize points for library
        const normalized = stroke.points.map(p => Array.isArray(p) ? p : [p.x, p.y, 0.5]);

        try {
            const outline = getStroke(normalized, {
                size: stroke.size,
                thinning: 0.5,
                smoothing: 0.5,
                streamline: 0.5,
                simulatePressure: true,
                last: true
            });

            if (outline.length === 0) return;

            const pathData = this.getSvgPathFromOutline(outline);
            const path = new Path2D(pathData);

            this.ctx.save();
            this.ctx.globalAlpha = alpha;
            this.ctx.fillStyle = stroke.color;
            this.ctx.fill(path);
            this.ctx.restore();
        } catch (e) {
            console.error('Render error:', e);
        }
    }

    getSvgPathFromOutline(points) {
        if (points.length === 0) return '';
        // CRITICAL FIX: Ensure clean SVG path syntax using 'L' for polygon outlines
        const d = [];
        d.push(`M ${points[0][0]} ${points[0][1]}`);
        for (let i = 1; i < points.length; i++) {
            d.push(`L ${points[i][0]} ${points[i][1]}`);
        }
        d.push('Z');
        return d.join(' ');
    }

    /**
     * COORDINATES & NAVEGATION
     */
    getCoord(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left) / this.zoomScale + this.panOffset.x,
            y: (e.clientY - rect.top) / this.zoomScale + this.panOffset.y
        };
    }

    getTouchDist(touches) {
        return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.render();
    }

    centerView() {
        this.zoomScale = 1.0;
        this.panOffset = { x: -window.innerWidth / 2, y: -window.innerHeight / 2 };
        this.render();
    }

    handleZoom(factor, centerX, centerY) {
        const oldScale = this.zoomScale;
        const newScale = Math.min(this.maxZoom, Math.max(this.minZoom, oldScale * factor));
        if (newScale === oldScale) return;

        // Origin-based scaling logic
        const worldX = (centerX / oldScale) + this.panOffset.x;
        const worldY = (centerY / oldScale) + this.panOffset.y;

        this.zoomScale = newScale;
        this.panOffset.x = worldX - (centerX / newScale);
        this.panOffset.y = worldY - (centerY / newScale);
        this.render();
    }

    setCursor(type) {
        document.body.style.cursor = type;
    }

    /**
     * REAL-TIME & GLOBAL SYNC
     */
    setupTabSync() {
        this.syncChannel.onmessage = (e) => {
            const { type, payload } = e.data;
            if (type === 'NEW_TRACE') {
                if (!this.traces.some(t => t.id === payload.id)) {
                    this.traces.push(payload);
                    this.render();
                }
            } else if (type === 'UNDO') {
                this.traces = this.traces.filter(t => t.id !== payload.id);
                this.render();
            } else if (type === 'CLEAR_WORLD') {
                this.traces = [];
                this.render();
            }
        };
    }

    setupRealtime() {
        if (typeof Pusher === 'undefined' || !this.user) return;
        if (this.pusher) return;

        this.pusher = new Pusher(PUSHER_KEY, { cluster: PUSHER_CLUSTER });
        this.channel = this.pusher.subscribe('trace-world');
        this.remoteCursors = new Map();
        this.presenceLayer = document.getElementById('remote-cursors-layer');

        this.channel.bind('new-stroke', (data) => {
            if (!this.traces.some(t => t.id === data.id)) {
                this.traces.push(data);
                this.render();
                this.updateStats();
            }
        });

        this.channel.bind('undo-stroke', (data) => {
            this.traces = this.traces.filter(t => t.id !== data.id);
            this.render();
            this.updateStats();
        });

        this.channel.bind('cursor-move', (data) => this.updateRemoteCursor(data));

        this.channel.bind('clear-world', () => {
            this.traces = [];
            this.render();
            this.updateStats();
        });
    }

    broadcastCursor(pos) {
        if (!this.user) return;
        fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event: 'cursor-move',
                payload: {
                    id: this.user.id, nickname: this.user.nickname,
                    avatar: this.user.avatar, color: this.currentColor, pos: pos
                }
            })
        }).catch(() => { });
    }

    updateRemoteCursor(data) {
        if (!this.user || data.id === this.user.id) return;
        let el = this.remoteCursors.get(data.id);
        if (!el) {
            el = document.createElement('div');
            el.className = 'remote-cursor';
            el.innerHTML = `
                <svg class="ghost-crayon" style="fill:${data.color}" viewBox="0 0 32 32">
                    <path d="M16 2 L4 22 L11 30 L21 30 L20 22 L28 22 Z" stroke="black" stroke-width="1"/>
                </svg>
                <div class="cursor-label">
                    <div class="cursor-avatar"></div>
                    <span>${data.nickname}</span>
                </div>
            `;
            this.presenceLayer.appendChild(el);
            this.renderAvatar(el.querySelector('.cursor-avatar'), data.avatar);
            this.remoteCursors.set(data.id, el);
        }
        const x = (data.pos.x - this.panOffset.x) * this.zoomScale;
        const y = (data.pos.y - this.panOffset.y) * this.zoomScale;
        el.style.transform = `translate(${x}px, ${y}px)`;
    }

    async saveStroke(stroke) {
        fetch('/api/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'new-stroke', payload: stroke })
        }).catch(() => { });

        fetch('/api/traces', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(stroke)
        }).catch(() => { });
    }

    async undo() {
        if (this.localHistory.length === 0) return;
        const id = this.localHistory.pop();
        this.traces = this.traces.filter(t => t.id !== id);
        this.render();
        this.updateStats();

        this.syncChannel.postMessage({ type: 'UNDO', payload: { id } });

        fetch('/api/sync', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ event: 'undo-stroke', payload: { id } })
        }).catch(() => { });

        fetch('/api/traces', {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        }).catch(() => { });
    }

    /**
     * WORLD DATA & UI stats
     */
    async loadWorld() {
        try {
            const res = await fetch('/api/traces');
            const data = await res.json();
            this.traces = data.traces || [];
            this.analytics = data.analytics || { visits: 0, clears: 0 };
            this.render();
            this.updateStats();
        } catch (e) { }
    }

    async clearAll() {
        if (!this.isAuthenticated) {
            if (this.isAdmin) return; // Wait for auth
            alert('administrative access required.');
            return;
        }
        if (!confirm('erase all traces from existence?')) return;

        await fetch('/api/traces', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: this.adminPass })
        });

        this.traces = [];
        this.render();
    }

    updateStats() {
        const el = document.getElementById('trace-count');
        if (el) el.innerText = this.traces.length;
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        document.body.setAttribute('data-theme', this.theme);
        localStorage.setItem('theme_v1', this.theme);
    }

    checkHover(e) {
        const tooltip = document.getElementById('trace-tooltip');
        const pos = this.getCoord(e);
        let hovered = null;

        for (let i = this.traces.length - 1; i >= 0; i--) {
            const stroke = this.traces[i];
            for (let j = 0; j < stroke.points.length; j += 10) {
                const p = stroke.points[j];
                const px = Array.isArray(p) ? p[0] : p.x;
                const py = Array.isArray(p) ? p[1] : p.y;
                if (Math.hypot(pos.x - px, pos.y - py) < 15) {
                    hovered = stroke;
                    break;
                }
            }
            if (hovered) break;
        }

        if (hovered) {
            tooltip.classList.remove('hidden');
            tooltip.style.left = (e.clientX + 15) + 'px';
            tooltip.style.top = (e.clientY + 15) + 'px';
            document.getElementById('tooltip-nickname').innerText = hovered.nickname;
            this.renderAvatar(document.getElementById('tooltip-avatar'), hovered.avatar);
        } else {
            tooltip.classList.add('hidden');
        }
    }
}

// Global initialization
window.addEventListener('load', () => {
    new TraceApp();
});
