/**
 * UniFind Campus — script.js
 * Lost & Found platform for IIIT Guwahati | Entropy 2026
 *
 * Architecture:
 *  - Supabase is authoritative for shared reports and photographs.
 *  - Trusted report writes and moderation actions use Supabase Edge Functions.
 *  - No localStorage-only fallback for report submission.
 *  - All user input is escaped before being rendered as HTML
 *
 * Configure SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY below to enable shared reports.
 */

'use strict';

/* ============================================================
   CONSTANTS & STATE
============================================================ */

const SUPABASE_URL = 'https://pmrmhsnwdjlcfjvtuwcc.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_j0HBKhS8MUaoJ5HtIQEiyQ_N_oChc-1';
const SUPABASE_BUCKET = 'item-photos';
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
let supabaseClient = null;
let lastCloudReadSucceeded = false;
let lastCloudErrorNotice = '';

function isSupabaseConfigured() {
  return Boolean(
    window.supabase &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL) &&
    !SUPABASE_URL.includes('PASTE_') &&
    SUPABASE_PUBLISHABLE_KEY &&
    !SUPABASE_PUBLISHABLE_KEY.includes('PASTE_')
  );
}

function setCloudStatus(message, status = 'info') {
  const el = document.getElementById('cloud-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.status = status;
  el.classList.remove('status-success', 'status-error', 'status-pending');
  el.classList.add(status === 'success' ? 'status-success' : status === 'error' ? 'status-error' : 'status-pending');
}

function initSupabase() {
  if (!isSupabaseConfigured()) {
    setCloudStatus('Setup required — add your new Supabase Project URL and publishable key in script.js.', 'error');
    return false;
  }
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    setCloudStatus('Connecting to the shared database…', 'pending');
    return true;
  } catch (error) {
    console.error('UniFind Campus: Supabase client initialization failed:', error);
    setCloudStatus('Could not initialize Supabase. Check the project URL and key.', 'error');
    return false;
  }
}

function mapSupabaseReport(row) {
  return {
    id: String(row.id),
    type: row.type,
    itemName: row.item_name,
    category: row.category || 'Other',
    description: row.description || '',
    location: row.location || '',
    date: row.report_date || '',
    contactMethod: row.contact_method || '',
    contactDetails: row.contact_details || '',
    photoDataURL: row.photo_url || '',
    resolved: Boolean(row.resolved),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

const CATEGORIES = [
  'Electronics',
  'Bags & Accessories',
  'Books & Stationery',
  'Clothing',
  'ID & Documents',
  'Keys',
  'Sports & Recreation',
  'Jewelry & Accessories',
  'Food & Containers',
  'Other',
];

/** In-memory state */
let state = {
  reports: [],
  currentType: 'lost',   // 'lost' | 'found'
  searchQuery: '',
  filterType: 'all',     // 'all' | 'lost' | 'found'
  filterCategory: 'all',
  photoDataURL: null,    // base64 data-URL of the selected photo
  pendingResolveId: null,
};

/* ============================================================
   UTILITIES
============================================================ */

/**
 * Escape a string so it's safe to insert into innerHTML.
 * Prevents XSS from user-entered text.
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format a date string (YYYY-MM-DD) to a human-readable form.
 * @param {string} dateStr
 * @returns {string}
 */
function formatDate(dateStr) {
  if (!dateStr) return 'Unknown date';
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

/**
 * Get today's date as YYYY-MM-DD string.
 * @returns {string}
 */
function todayISO() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Clamp a number of bytes to a human-readable size string.
 * @param {number} bytes
 * @returns {string}
 */
function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ============================================================
   SHARED CLOUD DATA
============================================================ */

async function loadReports() {
  lastCloudReadSucceeded = false;
  if (!supabaseClient) {
    setCloudStatus('Cloud sync unavailable until Supabase is configured.', 'error');
    return [];
  }
  setCloudStatus('Loading reports from Supabase…', 'pending');
  const { data, error } = await supabaseClient
    .from('reports_public')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('UniFind Campus: could not load shared reports:', error);
    setCloudStatus('Database read failed. Check SQL setup, view permissions, and project credentials.', 'error');
    const message = error.message || 'Check your Supabase configuration and internet connection.';
    if (message !== lastCloudErrorNotice) showToast('Could not load reports', message, 'error', 8000);
    lastCloudErrorNotice = message;
    return [];
  }
  lastCloudErrorNotice = '';
  lastCloudReadSucceeded = true;
  setCloudStatus('Cloud sync active · reports are shared across devices', 'success');
  return (data || []).map(mapSupabaseReport);
}

async function refreshReports() {
  state.reports = await loadReports();
  updateStats();
  renderItems();
  return lastCloudReadSucceeded;
}

/* ============================================================
   STATS
============================================================ */

function computeStats() {
  const all = state.reports;
  const resolved = all.filter((r) => r.resolved);
  const open = all.filter((r) => !r.resolved);
  const lost = open.filter((r) => r.type === 'lost');
  const found = open.filter((r) => r.type === 'found');
  return {
    total: all.length,
    open: open.length,
    resolved: resolved.length,
    lost: lost.length,
    found: found.length,
  };
}

function updateStats() {
  const s = computeStats();

  const setEl = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setEl('stat-total', s.total);
  setEl('stat-open', s.open);
  setEl('stat-resolved', s.resolved);
  setEl('dash-lost', s.lost);
  setEl('dash-found', s.found);
  setEl('dash-resolved', s.resolved);
  setEl('dash-total', s.total);
}

/* ============================================================
   TOAST NOTIFICATIONS
============================================================ */

/**
 * Show a toast notification.
 * @param {string} title
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} [duration=4000]
 */
function showToast(title, message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const icons = {
    success: '✓',
    error: '✗',
    info: 'i',
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  toast.innerHTML = `
    <div class="toast-icon">${escapeHTML(icons[type] || 'i')}</div>
    <div class="toast-body">
      <div class="toast-title">${escapeHTML(title)}</div>
      ${message ? `<div class="toast-message">${escapeHTML(message)}</div>` : ''}
    </div>
    <button class="toast-dismiss" aria-label="Dismiss notification">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
    </button>
  `;

  const dismiss = () => {
    toast.classList.add('toast-exit');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };

  toast.querySelector('.toast-dismiss').addEventListener('click', dismiss);
  container.appendChild(toast);

  const timer = setTimeout(dismiss, duration);
  toast.querySelector('.toast-dismiss').addEventListener('click', () => clearTimeout(timer), { once: true });
}

/* ============================================================
   ITEM CARD RENDERING
============================================================ */

/**
 * Return an HTML string for a single item card.
 * All dynamic values are escaped.
 * @param {Object} report
 * @returns {string}
 */
function renderCard(report) {
  const statusLabel = report.resolved
    ? 'Resolved'
    : report.type === 'lost'
    ? 'Lost'
    : 'Found';

  const statusClass = report.resolved ? 'resolved' : report.type;

  const photoHTML = report.photoDataURL
    ? `<img src="${report.photoDataURL}" alt="${escapeHTML(report.itemName)} photo" loading="lazy" />`
    : `<div class="card-photo-placeholder">
         <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
         <span>No photo</span>
       </div>`;

  const contactHTML = report.contactMethod && report.contactDetails
    ? `<div class="card-meta-item">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.93h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.18 6.18l1.56-1.56a2 2 0 0 1 2.11-.45c.9.376 1.85.6 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
         ${escapeHTML(report.contactMethod)}: ${escapeHTML(report.contactDetails)}
       </div>`
    : '';

  const resolveBtn = !report.resolved
    ? `<button class="btn btn-resolve" onclick="openResolveModal('${escapeHTML(report.id)}')" aria-label="Mark ${escapeHTML(report.itemName)} as resolved">
         <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>
         Resolve
       </button>`
    : `<span class="status-badge resolved" style="font-size:11px;padding:4px 10px;">
         <span class="status-dot" aria-hidden="true"></span> Resolved
       </span>`;

  return `
    <article class="item-card ${report.resolved ? 'resolved' : ''}" role="listitem" data-id="${escapeHTML(report.id)}">
      <div class="card-photo">${photoHTML}</div>
      <div class="card-body">
        <div class="card-header-row">
          <h3 class="card-title">${escapeHTML(report.itemName)}</h3>
          <span class="status-badge ${statusClass}" aria-label="Status: ${statusLabel}">
            <span class="status-dot" aria-hidden="true"></span>
            ${escapeHTML(statusLabel)}
          </span>
        </div>
        <span class="card-category">${escapeHTML(report.category)}</span>
        <p class="card-description">${escapeHTML(report.description)}</p>
        <div class="card-meta">
          <div class="card-meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
            ${escapeHTML(report.location)}
          </div>
          <div class="card-meta-item">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
            ${formatDate(report.date)}
          </div>
          ${contactHTML}
        </div>
        <div class="card-actions">
          <button class="btn btn-view" onclick="openModal('${escapeHTML(report.id)}')" aria-label="View details for ${escapeHTML(report.itemName)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            View Details
          </button>
          ${resolveBtn}
        </div>
      </div>
    </article>
  `;
}

/* ============================================================
   BROWSE / FILTER / SEARCH
============================================================ */

function getFilteredReports() {
  return state.reports.filter((r) => {
    // Resolved items leave the active list and are displayed separately for up to one hour.
    if (r.resolved) return false;
    // Type filter
    if (state.filterType !== 'all') {
      if (r.type !== state.filterType) return false;
    }

    // Category filter
    if (state.filterCategory !== 'all') {
      if (r.category !== state.filterCategory) return false;
    }

    // Search filter
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const haystack = [r.itemName, r.description, r.category, r.location]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });
}

function renderItems() {
  const grid = document.getElementById('items-grid');
  const emptyState = document.getElementById('empty-state');
  const emptyMessage = document.getElementById('empty-message');
  const resolvedSection = document.getElementById('recently-resolved-section');
  const resolvedGrid = document.getElementById('resolved-grid');
  if (!grid || !emptyState) return;

  const filtered = getFilteredReports();
  if (filtered.length === 0) {
    grid.innerHTML = '';
    emptyState.style.display = 'flex';
    if (state.reports.filter((r) => !r.resolved).length === 0) {
      emptyMessage.textContent = 'No active reports yet. Be the first to post a lost or found item!';
    } else {
      emptyMessage.textContent = 'No active items match your search. Try different keywords or clear your filters.';
    }
  } else {
    emptyState.style.display = 'none';
    const sorted = [...filtered].sort((a, b) => b.createdAt - a.createdAt);
    grid.innerHTML = sorted.map(renderCard).join('');
  }

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentlyResolved = state.reports
    .filter((r) => r.resolved && r.resolvedAt && r.resolvedAt >= oneHourAgo)
    .filter((r) => {
      if (state.filterType !== 'all' && r.type !== state.filterType) return false;
      if (state.filterCategory !== 'all' && r.category !== state.filterCategory) return false;
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        if (![r.itemName, r.description, r.category, r.location].join(' ').toLowerCase().includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  if (resolvedSection && resolvedGrid) {
    resolvedSection.style.display = recentlyResolved.length ? 'block' : 'none';
    resolvedGrid.innerHTML = recentlyResolved.map(renderCard).join('');
  }
}

function clearAllFilters() {
  state.searchQuery = '';
  state.filterType = 'all';
  state.filterCategory = 'all';

  const searchInput = document.getElementById('search-input');
  const categoryFilter = document.getElementById('category-filter');
  const clearSearch = document.getElementById('clear-search');

  if (searchInput) { searchInput.value = ''; }
  if (categoryFilter) { categoryFilter.value = 'all'; }
  if (clearSearch) { clearSearch.style.display = 'none'; }

  // Reset filter buttons
  document.querySelectorAll('.filter-btn').forEach((btn) => {
    const isAll = btn.dataset.filter === 'all';
    btn.classList.toggle('active', isAll);
    btn.setAttribute('aria-pressed', isAll ? 'true' : 'false');
  });

  renderItems();
}

/* ============================================================
   NAVBAR
============================================================ */

function initNavbar() {
  const navbar = document.getElementById('navbar');
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobile-menu');

  if (!navbar) return;

  // Scroll effect
  const onScroll = () => {
    navbar.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Mobile hamburger
  if (hamburger && mobileMenu) {
    hamburger.addEventListener('click', () => {
      const isOpen = mobileMenu.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      mobileMenu.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
    });

    // Close menu when clicking any mobile link
    mobileMenu.querySelectorAll('.mobile-link').forEach((link) => {
      link.addEventListener('click', closeMobileMenu);
    });
  }
}

function closeMobileMenu() {
  const hamburger = document.getElementById('hamburger');
  const mobileMenu = document.getElementById('mobile-menu');
  if (!hamburger || !mobileMenu) return;
  mobileMenu.classList.remove('open');
  hamburger.setAttribute('aria-expanded', 'false');
  mobileMenu.setAttribute('aria-hidden', 'true');
}

/* ============================================================
   REPORT TYPE SWITCHING
============================================================ */

/**
 * Switch the form between Lost and Found mode.
 * @param {'lost'|'found'} type
 */
function setReportType(type) {
  if (type !== 'lost' && type !== 'found') return;
  state.currentType = type;

  const lostBtn = document.getElementById('type-lost-btn');
  const foundBtn = document.getElementById('type-found-btn');
  const locationLabel = document.getElementById('location-label');
  const dateLabel = document.getElementById('date-label');
  const submitText = document.getElementById('submit-btn-text');

  if (lostBtn && foundBtn) {
    const isLost = type === 'lost';

    lostBtn.classList.toggle('active', isLost);
    lostBtn.setAttribute('aria-pressed', isLost ? 'true' : 'false');

    foundBtn.classList.toggle('active', !isLost);
    foundBtn.setAttribute('aria-pressed', !isLost ? 'true' : 'false');

    // Update labels — but NEVER remove the date input element
    if (locationLabel) {
      locationLabel.innerHTML = isLost
        ? 'Last Seen Location <span class="required" aria-hidden="true">*</span>'
        : 'Where Found <span class="required" aria-hidden="true">*</span>';
    }
    if (dateLabel) {
      dateLabel.innerHTML = isLost
        ? 'Date Lost <span class="required" aria-hidden="true">*</span>'
        : 'Date Found <span class="required" aria-hidden="true">*</span>';
    }

    if (submitText) {
      submitText.textContent = isLost ? 'Post Lost Report' : 'Post Found Report';
    }
  }
}

/**
 * Scroll to the report section and pre-select the report type.
 * Called from the hero buttons.
 * @param {'lost'|'found'} type
 */
function scrollToReport(type) {
  setReportType(type);
  const section = document.getElementById('report-section');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ============================================================
   PHOTO UPLOAD
============================================================ */

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Compress an image file to a data-URL using a canvas.
 * Target: max 900px wide, JPEG quality 0.82 (good visual / size trade-off).
 * @param {File} file
 * @returns {Promise<string>} base64 data-URL
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 900;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          if (width > height) {
            height = Math.round((height * MAX) / width);
            width = MAX;
          } else {
            width = Math.round((width * MAX) / height);
            height = MAX;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        // Use JPEG for compression (even for PNG/WebP source)
        const dataURL = canvas.toDataURL('image/jpeg', 0.82);
        resolve(dataURL);
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

function showPhotoPreview(dataURL) {
  const placeholder = document.getElementById('upload-placeholder');
  const preview = document.getElementById('upload-preview');
  const previewImg = document.getElementById('preview-img');
  const uploadArea = document.getElementById('upload-area');

  if (placeholder) placeholder.style.display = 'none';
  if (preview) preview.style.display = 'block';
  if (previewImg) previewImg.src = dataURL;
  if (uploadArea) {
    uploadArea.classList.add('has-file');
    uploadArea.removeAttribute('tabindex');
  }
}

function clearPhotoPreview() {
  const placeholder = document.getElementById('upload-placeholder');
  const preview = document.getElementById('upload-preview');
  const previewImg = document.getElementById('preview-img');
  const uploadArea = document.getElementById('upload-area');
  const photoInput = document.getElementById('photo-input');

  if (placeholder) placeholder.style.display = '';
  if (preview) preview.style.display = 'none';
  if (previewImg) previewImg.src = '';
  if (uploadArea) {
    uploadArea.classList.remove('has-file');
    uploadArea.setAttribute('tabindex', '0');
  }
  if (photoInput) photoInput.value = '';
  state.photoDataURL = null;
}

/**
 * Handle a photo File object: validate, compress, preview.
 * @param {File} file
 */
async function handlePhotoFile(file) {
  const photoError = document.getElementById('photo-error');

  // Type validation
  if (!ACCEPTED_TYPES.includes(file.type)) {
    if (photoError) photoError.textContent = 'Only JPG, PNG, and WebP images are accepted.';
    clearPhotoPreview();
    return;
  }

  // Size validation
  if (file.size > MAX_FILE_SIZE_BYTES) {
    if (photoError) {
      photoError.textContent = `File is too large (${humanFileSize(file.size)}). Maximum is 10 MB.`;
    }
    clearPhotoPreview();
    return;
  }

  if (photoError) photoError.textContent = '';

  try {
    const dataURL = await compressImage(file);
    state.photoDataURL = dataURL;
    showPhotoPreview(dataURL);
  } catch (err) {
    if (photoError) photoError.textContent = 'Could not process the image. Please try another file.';
    clearPhotoPreview();
  }
}

function initPhotoUpload() {
  const uploadArea = document.getElementById('upload-area');
  const photoInput = document.getElementById('photo-input');
  const removePhoto = document.getElementById('remove-photo');

  if (!uploadArea || !photoInput) return;

  // Click on upload area (not on the hidden input itself, just the visible area)
  uploadArea.addEventListener('click', (e) => {
    // Avoid double-triggering when user clicks the file input directly
    if (e.target !== photoInput) {
      photoInput.click();
    }
  });

  // Keyboard activation for the upload area
  uploadArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      photoInput.click();
    }
  });

  // File selected via input
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (file) await handlePhotoFile(file);
  });

  // Drag & Drop
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });

  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('dragover');
  });

  uploadArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) await handlePhotoFile(file);
  });

  // Remove photo
  if (removePhoto) {
    removePhoto.addEventListener('click', (e) => {
      e.stopPropagation();
      clearPhotoPreview();
    });
  }
}

/* ============================================================
   FORM VALIDATION
============================================================ */

/**
 * Show or clear a field-level error.
 * @param {string} fieldId - ID of the field
 * @param {string} errorId - ID of the error span
 * @param {string} [message] - Error message, or empty to clear
 */
function setFieldError(fieldId, errorId, message) {
  const field = document.getElementById(fieldId);
  const errorEl = document.getElementById(errorId);

  if (field) {
    field.classList.toggle('error', !!message);
  }
  if (errorEl) {
    errorEl.textContent = message || '';
  }
}

function clearAllErrors() {
  ['item-name', 'item-category', 'item-description', 'item-location', 'item-date'].forEach((id) => {
    setFieldError(id, `${id}-error`, '');
  });
  const privacyError = document.getElementById('privacy-error');
  const photoError = document.getElementById('photo-error');
  if (privacyError) privacyError.textContent = '';
  if (photoError) photoError.textContent = '';
}

/**
 * Validate the form fields and return true if everything is valid.
 * @returns {boolean}
 */
function validateForm() {
  let valid = true;
  clearAllErrors();

  const itemName = document.getElementById('item-name');
  const category = document.getElementById('item-category');
  const description = document.getElementById('item-description');
  const location = document.getElementById('item-location');
  const date = document.getElementById('item-date');
  const privacyCheck = document.getElementById('privacy-check');

  if (!itemName || !itemName.value.trim()) {
    setFieldError('item-name', 'item-name-error', 'Please enter the item name.');
    valid = false;
  } else if (itemName.value.trim().length < 2) {
    setFieldError('item-name', 'item-name-error', 'Item name must be at least 2 characters.');
    valid = false;
  }

  if (!category || !category.value) {
    setFieldError('item-category', 'item-category-error', 'Please select a category.');
    valid = false;
  }

  if (!description || !description.value.trim()) {
    setFieldError('item-description', 'item-description-error', 'Please add a description.');
    valid = false;
  } else if (description.value.trim().length < 10) {
    setFieldError(
      'item-description',
      'item-description-error',
      'Description should be at least 10 characters.'
    );
    valid = false;
  }

  if (!location || !location.value.trim()) {
    setFieldError('item-location', 'item-location-error', 'Please enter the location.');
    valid = false;
  }

  if (!date || !date.value) {
    setFieldError('item-date', 'item-date-error', 'Please select a date.');
    valid = false;
  } else if (date.value > todayISO()) {
    setFieldError('item-date', 'item-date-error', 'Date cannot be in the future.');
    valid = false;
  }

  if (!state.photoDataURL) {
    const photoError = document.getElementById('photo-error');
    if (photoError) photoError.textContent = 'Please upload a photo of the item.';
    valid = false;
  }

  if (privacyCheck && !privacyCheck.checked) {
    const privacyError = document.getElementById('privacy-error');
    if (privacyError) privacyError.textContent = 'You must confirm the information and agree to the terms.';
    valid = false;
  }

  return valid;
}

/* ============================================================
   FORM SUBMISSION
============================================================ */

function initForm() {
  const form = document.getElementById('report-form');
  if (!form) return;

  // Character count for description
  const descTextarea = document.getElementById('item-description');
  const descCount = document.getElementById('desc-count');
  if (descTextarea && descCount) {
    descTextarea.addEventListener('input', () => {
      descCount.textContent = descTextarea.value.length;
    });
  }

  // Contact method toggle: show/hide contact detail placeholder
  const contactMethod = document.getElementById('contact-method');
  const contactDetails = document.getElementById('contact-details');
  if (contactMethod && contactDetails) {
    const updateContactPlaceholder = () => {
      const method = contactMethod.value;
      const placeholders = {
        Email: 'your@email.com',
        Phone: '+91 XXXXX XXXXX',
        Instagram: '@yourhandle',
        WhatsApp: '+91 XXXXX XXXXX',
      };
      contactDetails.placeholder = method
        ? (placeholders[method] || 'Enter contact details…')
        : 'Select a contact method first…';
      contactDetails.disabled = !method;
      if (!method) contactDetails.value = '';
    };
    contactMethod.addEventListener('change', updateContactPlaceholder);
    updateContactPlaceholder();
  }

  // Set default date to today
  const dateInput = document.getElementById('item-date');
  if (dateInput) {
    dateInput.value = todayISO();
    dateInput.max = todayISO();
    // Update max every day (if the page is open that long)
    setInterval(() => {
      dateInput.max = todayISO();
    }, 60000);
  }

  form.addEventListener('submit', handleFormSubmit);
}

async function handleFormSubmit(e) {
  e.preventDefault();

  if (!validateForm()) {
    const firstError = document.querySelector('.field-error:not(:empty)');
    if (firstError) {
      firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const form = e.currentTarget;
  const submitBtn = document.getElementById('submit-btn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation: spin 1s linear infinite;" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      Posting…
    `;
  }

  const itemName = document.getElementById('item-name').value.trim();
  const category = document.getElementById('item-category').value;
  const description = document.getElementById('item-description').value.trim();
  const location = document.getElementById('item-location').value.trim();
  const date = document.getElementById('item-date').value;
  const contactMethod = document.getElementById('contact-method').value;
  const contactDetails = document.getElementById('contact-details').value.trim();
  try {
    if (!supabaseClient || !isSupabaseConfigured()) {
      throw new Error('Cloud sync is not configured yet. Add your Supabase Project URL and publishable key in script.js, then deploy the Edge Functions and SQL setup. No report was saved.');
    }

    const photoBlob = await (await fetch(state.photoDataURL)).blob();
    if (photoBlob.size > MAX_FILE_SIZE_BYTES) {
      throw new Error('The processed photo exceeds 10 MiB. Please choose a smaller image.');
    }
    const formData = new FormData();
    formData.append('type', state.currentType);
    formData.append('item_name', itemName);
    formData.append('category', category);
    formData.append('description', description);
    formData.append('location', location);
    formData.append('report_date', date);
    formData.append('contact_method', contactMethod);
    formData.append('contact_details', contactDetails);
    formData.append('contact_is_public', document.getElementById('contact-public')?.checked ? 'true' : 'false');
    formData.append('website', document.getElementById('website')?.value || ''); // honeypot should remain blank
    formData.append('photo', photoBlob, 'item-photo.jpg');

    setCloudStatus('Uploading photo and saving report…', 'pending');
    const response = await fetch(`${SUPABASE_URL}/functions/v1/submit-report`, {
      method: 'POST',
      headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
      body: formData
    });
    let result = {};
    try { result = await response.json(); } catch { /* non-JSON server response */ }
    if (!response.ok) {
      throw new Error(result.error || `Cloud submission failed (HTTP ${response.status}).`);
    }
    if (!result.report || !result.report.id) {
      throw new Error('The server did not confirm a saved report. Please check Supabase before retrying.');
    }

    // Refresh from the public view so what is shown matches what other devices can read.
    const listingVerified = await refreshReports();
    const reportVisible = state.reports.some((r) => String(r.id) === String(result.report.id));

    // The Edge Function confirmed the row was inserted, so clear the form to avoid duplicate retries.
    form.reset();
    document.getElementById('contact-method')?.dispatchEvent(new Event('change'));
    clearPhotoPreview();
    clearAllErrors();
    setReportType(state.currentType);

    const descCount = document.getElementById('desc-count');
    if (descCount) descCount.textContent = '0';
    const dateInput = document.getElementById('item-date');
    if (dateInput) dateInput.value = todayISO();

    if (listingVerified && reportVisible && !result.warning) {
      setCloudStatus('Cloud sync active · report saved and shared', 'success');
      showToast(
        'Report Posted',
        `Your report for "${itemName}" was saved to UniFind Campus and is visible on the shared board.`,
        'success',
        6000
      );
    } else {
      setCloudStatus('The server saved the report, but the public listing could not be verified. Check the reports_public view permissions.', 'error');
      showToast(
        'Report Saved — Check Visibility',
        'The server confirmed the report was saved. The website could not verify that it appears on the public board, so do not submit it again. Check the reports_public view and its SELECT grant in Supabase.',
        'info',
        10000
      );
    }
    document.getElementById('browse')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    console.error('UniFind Campus: report submission failed:', error);
    const detail = error && error.message ? ` Details: ${error.message}` : '';
    setCloudStatus('Submission failed. No successful cloud save was confirmed.', 'error');
    showToast(
      'Report Not Saved',
      `UniFind Campus could not save this report to Supabase. Your form is still filled in. Check the Edge Function deployment, Storage/SQL setup, key, and permissions.${detail}`,
      'error',
      10000
    );
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      const submitText = state.currentType === 'lost' ? 'Post Lost Report' : 'Post Found Report';
      submitBtn.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>
        <span id="submit-btn-text">${escapeHTML(submitText)}</span>
      `;
    }
  }
}

/* ============================================================
   ITEM DETAILS MODAL
============================================================ */

function openModal(id) {
  const report = state.reports.find((r) => r.id === id);
  if (!report) return;

  const overlay = document.getElementById('modal-overlay');
  const content = document.getElementById('modal-content');
  if (!overlay || !content) return;

  const statusLabel = report.resolved
    ? 'Resolved'
    : report.type === 'lost'
    ? 'Lost'
    : 'Found';
  const statusClass = report.resolved ? 'resolved' : report.type;

  const contactBlock =
    report.contactMethod && report.contactDetails
      ? `<div class="modal-contact-block">
           <div class="modal-contact-label">Contact via ${escapeHTML(report.contactMethod)}</div>
           <div class="modal-contact-value">${escapeHTML(report.contactDetails)}</div>
         </div>`
      : '';

  const photoBlock = report.photoDataURL
    ? `<img class="modal-photo" src="${report.photoDataURL}" alt="Photo of ${escapeHTML(report.itemName)}" />`
    : '';

  const resolveBtn = !report.resolved
    ? `<button class="btn btn-resolved" onclick="openResolveModal('${escapeHTML(report.id)}'); closeModal();" aria-label="Mark as resolved">
         <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-5"/></svg>
         Mark Resolved
       </button>`
    : '';

  content.innerHTML = `
    ${photoBlock}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;">
      <h2 class="modal-section-title" id="modal-title" style="margin-bottom:0;">${escapeHTML(report.itemName)}</h2>
      <span class="status-badge ${statusClass}">${escapeHTML(statusLabel)}</span>
    </div>
    <span class="card-category" style="margin-bottom:20px;display:inline-flex;">${escapeHTML(report.category)}</span>

    <div class="modal-meta-grid">
      <div class="modal-meta-item">
        <div class="modal-meta-label">Location</div>
        <div class="modal-meta-value">${escapeHTML(report.location)}</div>
      </div>
      <div class="modal-meta-item">
        <div class="modal-meta-label">${report.type === 'lost' ? 'Date Lost' : 'Date Found'}</div>
        <div class="modal-meta-value">${formatDate(report.date)}</div>
      </div>
    </div>

    <h3 class="modal-sub-title">Description</h3>
    <p class="modal-description">${escapeHTML(report.description)}</p>

    ${contactBlock}

    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      ${resolveBtn}
    </div>
  `;

  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';

  // Focus the modal
  const modal = document.getElementById('item-modal');
  if (modal) modal.focus();
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

/* ============================================================
   RESOLVE MODAL
============================================================ */

async function openResolveModal(id) {
  state.pendingResolveId = id;
  if (!supabaseClient || !isSupabaseConfigured()) {
    showToast('Cloud setup required', 'Configure Supabase before resolving shared reports.', 'error');
    return;
  }
  const { data } = await supabaseClient.auth.getSession();
  if (!data?.session) {
    showModeratorModal();
    showToast('Moderator sign-in required', 'Sign in with an approved moderator account to continue.', 'info', 6000);
    return;
  }
  openResolveConfirmation();
}

function closeResolveModal() {
  state.pendingResolveId = null;
  const overlay = document.getElementById('resolve-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

async function confirmResolve() {
  const id = state.pendingResolveId;
  if (!id) return;
  if (!supabaseClient || !isSupabaseConfigured()) {
    showToast('Cloud setup required', 'Configure Supabase before resolving shared reports.', 'error');
    return;
  }
  const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
  const session = sessionData?.session;
  if (sessionError || !session) {
    closeResolveModal();
    state.pendingResolveId = id;
    showModeratorModal();
    showToast('Moderator sign-in required', 'Sign in with an approved moderator account to resolve a report.', 'info', 6000);
    return;
  }
  const confirmBtn = document.getElementById('confirm-resolve-btn');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Updating…'; }
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/resolve-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${session.access_token}`
      },
      body: JSON.stringify({ id })
    });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok) throw new Error(result.error || `Resolution failed (HTTP ${response.status}).`);
    closeResolveModal();
    await refreshReports();
    showToast('Marked as Resolved', 'The report will be automatically deleted with its photo after one hour.', 'success', 6000);
  } catch (error) {
    console.error('UniFind Campus: report resolution failed:', error);
    showToast('Update failed', error.message || 'Could not mark this report as resolved.', 'error', 8000);
  } finally {
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Yes, Mark Resolved'; }
  }
}

/* ============================================================
   PRIVACY MODAL
============================================================ */

function showPrivacyModal() {
  const overlay = document.getElementById('privacy-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
}

function closePrivacyModal() {
  const overlay = document.getElementById('privacy-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

/* ============================================================
   MODERATOR AUTHENTICATION
============================================================ */

function showModeratorModal() {
  const overlay = document.getElementById('moderator-overlay');
  const errorEl = document.getElementById('moderator-login-error');
  if (!overlay) return;
  if (errorEl) errorEl.textContent = '';
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
  document.getElementById('moderator-email')?.focus();
}

function closeModeratorModal() {
  const overlay = document.getElementById('moderator-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'true');
  overlay.classList.remove('visible');
  document.body.style.overflow = '';
}

function initModeratorAuth() {
  const form = document.getElementById('moderator-login-form');
  const errorEl = document.getElementById('moderator-login-error');
  const signoutBtn = document.getElementById('moderator-signout-btn');
  if (form) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!supabaseClient) {
        if (errorEl) errorEl.textContent = 'Supabase is not configured yet.';
        return;
      }
      const email = document.getElementById('moderator-email')?.value.trim() || '';
      const password = document.getElementById('moderator-password')?.value || '';
      const submit = document.getElementById('moderator-login-submit');
      if (submit) { submit.disabled = true; submit.textContent = 'Signing in…'; }
      if (errorEl) errorEl.textContent = '';
      try {
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        if (errorEl) errorEl.textContent = '';
        closeModeratorModal();
        showToast('Signed in', 'Your account has signed in. Moderator permissions are checked securely when you resolve a report.', 'success', 6000);
        if (signoutBtn) signoutBtn.style.display = 'block';
        if (state.pendingResolveId) openResolveConfirmation();
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message || 'Sign-in failed. Check the account details.';
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = 'Sign in'; }
      }
    });
  }
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      if (!supabaseClient) return;
      const { error } = await supabaseClient.auth.signOut();
      if (error) showToast('Sign out failed', error.message, 'error');
      else {
        signoutBtn.style.display = 'none';
        closeModeratorModal();
        showToast('Signed out', 'Moderator session ended on this device.', 'info');
      }
    });
  }
}

function openResolveConfirmation() {
  const overlay = document.getElementById('resolve-overlay');
  if (!overlay) return;
  overlay.setAttribute('aria-hidden', 'false');
  overlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
  document.getElementById('confirm-resolve-btn')?.focus();
}

/* ============================================================
   CLEAR ALL DATA
============================================================ */

function clearAllData() {
  clearAllFilters();
  showToast('Filters reset', 'Your search and filters were cleared. Shared reports were not deleted.', 'info', 5000);
}


/* ============================================================
   SEARCH & FILTER — EVENT LISTENERS
============================================================ */

function initSearchAndFilter() {
  const searchInput = document.getElementById('search-input');
  const clearSearch = document.getElementById('clear-search');
  const categoryFilter = document.getElementById('category-filter');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value.trim();
      if (clearSearch) {
        clearSearch.style.display = state.searchQuery ? '' : 'none';
      }
      renderItems();
    });
  }

  if (clearSearch) {
    clearSearch.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearSearch.style.display = 'none';
      renderItems();
      searchInput.focus();
    });
  }

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filterType = btn.dataset.filter || 'all';

      document.querySelectorAll('.filter-btn').forEach((b) => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      renderItems();
    });
  });

  if (categoryFilter) {
    categoryFilter.addEventListener('change', () => {
      state.filterCategory = categoryFilter.value;
      renderItems();
    });
  }
}

/* ============================================================
   MODAL CLOSE — KEYBOARD & OVERLAY CLICK
============================================================ */

function initModalHandlers() {
  // Escape key closes any open modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeResolveModal();
      closePrivacyModal();
      closeModeratorModal();
    }
  });

  // Clicking an overlay closes only that modal (important for retaining a pending resolve action during sign-in).
  ['modal-overlay', 'resolve-overlay', 'privacy-overlay', 'moderator-overlay'].forEach((overlayId) => {
    const overlay = document.getElementById(overlayId);
    if (!overlay) return;
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return;
      if (overlayId === 'modal-overlay') closeModal();
      if (overlayId === 'resolve-overlay') closeResolveModal();
      if (overlayId === 'privacy-overlay') closePrivacyModal();
      if (overlayId === 'moderator-overlay') closeModeratorModal();
    });
  });

  // Modal close button
  const closeBtn = document.getElementById('modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
}

/* ============================================================
   SMOOTH SCROLL FOR ALL NAV LINKS
============================================================ */

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener('click', function (e) {
      const targetId = this.getAttribute('href').slice(1);
      const target = document.getElementById(targetId);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        closeMobileMenu();
      }
    });
  });
}

/* ============================================================
   ANIMATE STATS ON SCROLL (Intersection Observer)
============================================================ */

function animateNumber(el, target, duration = 800) {
  const start = performance.now();
  const startVal = parseInt(el.textContent, 10) || 0;

  const tick = (now) => {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(startVal + (target - startVal) * eased);
    if (progress < 1) requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function initStatAnimation() {
  const statEls = document.querySelectorAll('.stat-number, .dash-stat-num');
  if (!('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const target = parseInt(entry.target.textContent, 10) || 0;
          if (target > 0) animateNumber(entry.target, target);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );

  statEls.forEach((el) => observer.observe(el));
}

/* ============================================================
   ADD SPIN ANIMATION FOR LOADING STATE
============================================================ */

function injectSpinKeyframe() {
  if (document.getElementById('unifind-spin-style')) return;
  const style = document.createElement('style');
  style.id = 'unifind-spin-style';
  style.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
}

/* ============================================================
   INIT
============================================================ */

document.addEventListener('DOMContentLoaded', async () => {
  injectSpinKeyframe();
  initSupabase();
  initModeratorAuth();

  // Reports are cloud-authoritative; there is no local-only report fallback.
  state.reports = await loadReports();

  // Boot subsystems
  initNavbar();
  initForm();
  initPhotoUpload();
  initSearchAndFilter();
  initModalHandlers();
  initSmoothScroll();

  // Initial render
  updateStats();
  renderItems();

  // Refresh from the shared view periodically so another device's posts appear without manual reload.
  if (supabaseClient) {
    setInterval(() => {
      if (document.visibilityState === 'visible') refreshReports();
    }, 30000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshReports();
    });
  }

  // Animate stats once DOM is painted
  requestAnimationFrame(initStatAnimation);
});
