/**
 * CarVault Storage & State Manager
 * Implements Option B: Unique URL per sticker (carvault.in/s/<8-char-code>)
 * - Direct route lookup (sticker_code -> vehicle & vault)
 * - Zero-knowledge public gate: no vehicle hints before login
 * - Multi-tier escalating lockout defense (5 fails = 15m, 10 fails = 24h + SMS, 20 fails = disabled)
 * - 30-day "Remember this device" session management
 * - 15-minute Officer inspection view-only share passes
 * - Scratch claim code verification for unboxing
 */

const STORAGE_KEYS = {
  VAULT_STICKERS: 'carvault_stickers_v2',
  ACTIVE_STICKER_CODE: 'carvault_active_code_v2',
  DEVICE_SESSIONS: 'carvault_device_sessions_v2',
  OFFICER_PASSES: 'carvault_officer_passes_v2',
  AUDIT_LOGS: 'carvault_audit_logs_v2'
};

class VaultStorage {
  constructor() {
    this.initPromise = this.initDefaultTags();
  }

  async ready() {
    return this.initPromise;
  }

  // Sample placeholder document base64 representations
  createSampleDocumentImage(title, subtitle, color = '#2563eb') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#07090E" />
          <stop offset="100%" stop-color="#0E131F" />
        </linearGradient>
        <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${color}" />
          <stop offset="100%" stop-color="#38bdf8" />
        </linearGradient>
      </defs>
      <rect width="600" height="400" rx="16" fill="url(#bg)" stroke="#1e293b" stroke-width="2"/>
      <rect x="0" y="0" width="600" height="12" rx="6" fill="url(#accent)"/>
      <g transform="translate(40, 50)">
        <text x="0" y="30" font-family="'Plus Jakarta Sans', system-ui, sans-serif" font-weight="800" font-size="22" fill="#f8fafc">${title}</text>
        <text x="0" y="58" font-family="system-ui, sans-serif" font-size="13" fill="#94a3b8">${subtitle}</text>
        
        <line x1="0" y1="85" x2="520" y2="85" stroke="#334155" stroke-dasharray="4 4" />
        
        <rect x="0" y="110" width="520" height="180" rx="8" fill="#0B101D" stroke="#1e293b" />
        <text x="25" y="145" font-family="'Space Grotesk', monospace" font-size="15" font-weight="700" fill="#38bdf8">VEHICLE NO: GJ16-XX-2026</text>
        <text x="25" y="175" font-family="system-ui, sans-serif" font-size="13" fill="#cbd5e1">REGISTERED OWNER: NOORI TRANSPORT CO., BHARUCH</text>
        <text x="25" y="205" font-family="system-ui, sans-serif" font-size="13" fill="#cbd5e1">AUTHENTICATION: AES-256-GCM HARDWARE ENCRYPTED</text>
        <text x="25" y="235" font-family="system-ui, sans-serif" font-size="13" fill="#10b981">✓ MV ACT 1988 &amp; RULE 139 VALID DIGITAL COPY</text>
        <text x="25" y="265" font-family="monospace" font-size="11" fill="#64748b">CARVAULT NFC TAG: #k8Xq2mPz | SHA-256: 9a7f4c28...b781</text>
      </g>
    </svg>`;
    return 'data:image/svg+xml;base64,' + window.btoa(svg);
  }

  getDefaultActiveSticker() {
    return {
      code: 'k8Xq2mPz',
      status: 'active',
      claimCode: 'CV-8924-X',
      vehicleId: 'veh-gj16-2026',
      vehicleName: 'Mahindra Bolero Maxi Truck',
      vehicleNumber: 'GJ16-XX-2026',
      ownerName: 'Iqbal Patel (Noori Transport)',
      phone: '8866831535',
      documents: [
        {
          id: 'doc-rc',
          type: 'RC',
          title: 'Vehicle Registration Certificate (RC)',
          vehicleNo: 'GJ16-XX-2026',
          validTill: '2036-05-15',
          status: 'Valid',
          mimeType: 'image/svg+xml',
          fileName: 'RC_GJ16XX2026.svg',
          rawUrl: this.createSampleDocumentImage('REGISTRATION CERTIFICATE', 'Transport Dept, Govt of Gujarat (GJ16 Bharuch)', '#2563eb')
        },
        {
          id: 'doc-insurance',
          type: 'Insurance',
          title: 'Commercial Vehicle Insurance Policy',
          vehicleNo: 'GJ16-XX-2026',
          validTill: '2027-03-31',
          status: 'Active',
          mimeType: 'image/svg+xml',
          fileName: 'Policy_NewIndia_2026.svg',
          rawUrl: this.createSampleDocumentImage('MOTOR COMPREHENSIVE INSURANCE', 'New India Assurance Co. Ltd - Bharuch Branch', '#059669')
        },
        {
          id: 'doc-puc',
          type: 'PUC',
          title: 'Pollution Certificate (PUC)',
          vehicleNo: 'GJ16-XX-2026',
          validTill: '2027-01-10',
          status: 'Valid',
          mimeType: 'image/svg+xml',
          fileName: 'PUC_Valid_Jan2027.svg',
          rawUrl: this.createSampleDocumentImage('POLLUTION UNDER CONTROL (PUC)', 'Approved Emission Testing Center - GNFC Cross Road', '#10b981')
        },
        {
          id: 'doc-license',
          type: 'License',
          title: 'Commercial Driving License (HMV)',
          vehicleNo: 'HMV / Transport',
          validTill: '2030-08-20',
          status: 'Valid',
          mimeType: 'image/svg+xml',
          fileName: 'DL_Transport_Gujarat.svg',
          rawUrl: this.createSampleDocumentImage('DRIVING LICENSE (COMMERCIAL / HMV)', 'Licensing Authority: RTO Bharuch', '#d97706')
        },
        {
          id: 'doc-aadhaar',
          type: 'Aadhaar',
          title: 'Owner Identity (Aadhaar Card)',
          vehicleNo: 'Encrypted Personal ID',
          validTill: 'Permanent',
          status: 'Encrypted Private',
          mimeType: 'image/svg+xml',
          fileName: 'Aadhaar_Owner_Vault.svg',
          rawUrl: this.createSampleDocumentImage('AADHAAR IDENTIFICATION (PRIVATE)', 'UIDAI Verified Personal Identity Document', '#4f46e5')
        }
      ],
      lockout: {
        failedAttempts: 0,
        fails24h: 0,
        lockedUntil: 0,
        alertSent24h: false
      },
      activatedAt: new Date().toISOString()
    };
  }

  async initDefaultTags() {
    try {
      let existing = this.getAllStickers();
      if (!existing || Object.keys(existing).length === 0) {
        existing = {};
        const defaultActive = this.getDefaultActiveSticker();
        existing['k8Xq2mPz'] = defaultActive;
        existing['tag-bharuch-car-01'] = defaultActive;
        existing['u7Yt9wK2'] = {
          code: 'u7Yt9wK2',
          status: 'unclaimed',
          claimCode: 'CV-8924-X',
          createdDate: new Date().toISOString()
        };
        existing['tag-unclaimed-new-99'] = existing['u7Yt9wK2'];
        existing['d3Fj5vN1'] = {
          code: 'd3Fj5vN1',
          status: 'disabled',
          claimCode: 'CV-7733-Z',
          disableReason: 'Tag deactivated by owner / maximum lockout limit reached',
          phone: '8866831535',
          vehicleNumber: 'GJ16-XX-2026'
        };
        localStorage.setItem(STORAGE_KEYS.VAULT_STICKERS, JSON.stringify(existing));

        // Derive real cryptographic keys asynchronously
        if (window.VaultCrypto && window.crypto && window.crypto.subtle) {
          try {
            const defaultPin = "123456";
            const keyBundle = await window.VaultCrypto.setupVaultKeys(defaultPin);
            const dek = await window.VaultCrypto.unlockDataKeyWithPin(defaultPin, keyBundle);
            const encryptedDocs = [];
            for (const doc of defaultActive.documents) {
              const textBuffer = new TextEncoder().encode(doc.rawUrl);
              const encrypted = await window.VaultCrypto.encryptFile(dek, textBuffer);
              encryptedDocs.push({ ...doc, encryptedPayload: encrypted });
            }
            existing['k8Xq2mPz'].keyBundle = keyBundle;
            existing['k8Xq2mPz'].documents = encryptedDocs;
            existing['tag-bharuch-car-01'] = existing['k8Xq2mPz'];
            localStorage.setItem(STORAGE_KEYS.VAULT_STICKERS, JSON.stringify(existing));
          } catch (cryptoErr) {
            console.warn("Crypto key derivation notice:", cryptoErr);
          }
        }
      }

      if (!localStorage.getItem(STORAGE_KEYS.ACTIVE_STICKER_CODE)) {
        localStorage.setItem(STORAGE_KEYS.ACTIVE_STICKER_CODE, 'k8Xq2mPz');
      }
    } catch (e) {
      console.warn("initDefaultTags storage notice:", e);
    }
  }

  getAllStickers() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.VAULT_STICKERS)) || {};
    } catch (e) {
      return {};
    }
  }

  getSticker(code) {
    if (!code) return null;
    const stickers = this.getAllStickers();
    if (stickers[code]) return stickers[code];

    if (code === 'k8Xq2mPz' || code === 'tag-bharuch-car-01') {
      const defaultActive = this.getDefaultActiveSticker();
      this.saveSticker(defaultActive);
      return defaultActive;
    }

    // Auto-create blank unclaimed sticker for new codes (e.g. freshly scanned tag)
    const newSticker = {
      code: code,
      status: 'unclaimed',
      claimCode: 'CV-' + Math.floor(1000 + Math.random() * 9000) + '-X',
      createdDate: new Date().toISOString()
    };
    this.saveSticker(newSticker);
    return newSticker;
  }

  saveSticker(stickerData) {
    const stickers = this.getAllStickers();
    stickers[stickerData.code] = stickerData;
    if (stickerData.tagId) stickers[stickerData.tagId] = stickerData;
    localStorage.setItem(STORAGE_KEYS.VAULT_STICKERS, JSON.stringify(stickers));
  }

  getActiveStickerCode() {
    return localStorage.getItem(STORAGE_KEYS.ACTIVE_STICKER_CODE) || 'k8Xq2mPz';
  }

  setActiveStickerCode(code) {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_STICKER_CODE, code);
  }

  // Session & "Remember this device" management
  hasActiveSession(stickerCode) {
    try {
      const sessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.DEVICE_SESSIONS)) || {};
      const session = sessions[stickerCode];
      if (session && session.expiresAt > Date.now()) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  saveDeviceSession(stickerCode, rememberDevice = false) {
    try {
      const sessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.DEVICE_SESSIONS)) || {};
      // 30 days if "remember this device", else 15 minutes of inactivity
      const maxAgeMs = rememberDevice ? 30 * 24 * 60 * 60 * 1000 : 15 * 60 * 1000;
      sessions[stickerCode] = {
        token: 'sess_' + Math.random().toString(36).substring(2) + Date.now().toString(36),
        rememberDevice,
        savedAt: Date.now(),
        expiresAt: Date.now() + maxAgeMs
      };
      localStorage.setItem(STORAGE_KEYS.DEVICE_SESSIONS, JSON.stringify(sessions));
    } catch (e) {
      console.error(e);
    }
  }

  clearDeviceSession(stickerCode) {
    try {
      const sessions = JSON.parse(localStorage.getItem(STORAGE_KEYS.DEVICE_SESSIONS)) || {};
      delete sessions[stickerCode];
      localStorage.setItem(STORAGE_KEYS.DEVICE_SESSIONS, JSON.stringify(sessions));
    } catch (e) {}
  }

  // 15-Minute Officer View-Only Pass Generator
  createOfficerPass(stickerCode, durationMinutes = 15) {
    try {
      const passes = JSON.parse(localStorage.getItem(STORAGE_KEYS.OFFICER_PASSES)) || {};
      const token = 'pass_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
      const pass = {
        token,
        stickerCode,
        createdAt: Date.now(),
        expiresAt: Date.now() + durationMinutes * 60 * 1000,
        revoked: false
      };
      passes[stickerCode] = pass;
      localStorage.setItem(STORAGE_KEYS.OFFICER_PASSES, JSON.stringify(passes));
      return pass;
    } catch (e) {
      return null;
    }
  }

  getOfficerPass(stickerCode) {
    try {
      const passes = JSON.parse(localStorage.getItem(STORAGE_KEYS.OFFICER_PASSES)) || {};
      const pass = passes[stickerCode];
      if (pass && !pass.revoked && pass.expiresAt > Date.now()) {
        return pass;
      }
    } catch (e) {}
    return null;
  }

  revokeOfficerPass(stickerCode) {
    try {
      const passes = JSON.parse(localStorage.getItem(STORAGE_KEYS.OFFICER_PASSES)) || {};
      if (passes[stickerCode]) {
        passes[stickerCode].revoked = true;
      }
      localStorage.setItem(STORAGE_KEYS.OFFICER_PASSES, JSON.stringify(passes));
    } catch (e) {}
  }

  // Audit Logs
  getAuditLogs(stickerCode) {
    try {
      const logs = JSON.parse(localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS)) || [];
      return logs.filter(l => !stickerCode || l.stickerCode === stickerCode);
    } catch (e) {
      return [];
    }
  }

  addAuditLog(stickerCode, action, details) {
    try {
      const logs = JSON.parse(localStorage.getItem(STORAGE_KEYS.AUDIT_LOGS)) || [];
      logs.unshift({
        id: 'log-' + Date.now(),
        stickerCode,
        action,
        details,
        timestamp: new Date().toISOString()
      });
      localStorage.setItem(STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(logs.slice(0, 50)));
    } catch (e) {
      console.error(e);
    }
  }

  // Reset demo state
  resetAllData() {
    localStorage.removeItem(STORAGE_KEYS.VAULT_STICKERS);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_STICKER_CODE);
    localStorage.removeItem(STORAGE_KEYS.DEVICE_SESSIONS);
    localStorage.removeItem(STORAGE_KEYS.OFFICER_PASSES);
    localStorage.removeItem(STORAGE_KEYS.AUDIT_LOGS);
    return this.initDefaultTags();
  }
}

window.VaultStorage = new VaultStorage();
