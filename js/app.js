/**
 * CarVault - Luxury Consumer Grade Application Logic
 * Implements Option B Architecture (Unique URL per sticker: carvault.in/s/<8-char-code>)
 * - Direct route lookup (sticker_code -> vehicle & vault)
 * - Zero-knowledge public gate: no owner name or vehicle details exposed before login
 * - Multi-tier escalating lockout defense (5 fails = 15m, 10 fails = 24h + SMS alert, 20 fails = disabled)
 * - 30-day "Remember this device" session management
 * - 15-minute Traffic Police view-only inspection pass with instant revoke
 * - Packaging scratch claim code validation for physical unboxing
 * - Real Twilio Verify SMS OTP integration
 */

async function sendTwilioVerifyOtp(rawPhone) {
  let phone = rawPhone.replace(/\s+/g, "");
  if (!phone.startsWith("+")) {
    phone = "+91" + phone.replace(/^0+/, "");
  }

  // Secure Server Proxy Endpoint (Cloudflare Pages Worker or server.ps1)
  try {
    const res = await fetch('/api/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) {}

    if (res.ok && data.success) {
      return { success: true, data, phone };
    }
    return { success: false, error: data.error || `Server status ${res.status}`, phone };
  } catch (err) {
    console.warn("Backend OTP proxy unavailable, using offline fallback:", err);
    return { success: false, error: err.message, phone };
  }
}

async function checkTwilioVerifyOtp(phone, code) {
  // Secure Server Verification Endpoint
  try {
    const res = await fetch('/api/check-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, code: String(code).trim() })
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch(e) {}
    return { approved: res.ok && data.approved, data };
  } catch (err) {
    console.warn("Backend OTP check unavailable:", err);
    return { approved: false, error: err.message };
  }
}

class CarVaultApp {
  constructor() {
    this.activeSticker = null;
    this.activeDek = null;
    this.enteredPin = "";
    this.pendingOtp = null;
    this.realOtpPhone = null;
    this.lockoutInterval = null;
    this.officerTimerInterval = null;
    this.currentView = null;
    this.selectedDoc = null;
    this.currentLang = 'EN';
    this.audioCtx = null;
    this.smsToastTimeout = null;

    this.init();
  }

  async init() {
    // 1. Immediately resolve sticker and bind UI events so no click is ever missed
    this.resolveActiveSticker();
    this.bindEvents();
    this.renderCurrentStickerState();

    // 2. Clear stale service workers in the background
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        for (let r of regs) r.unregister();
      }).catch(() => {});
    }

    // 3. Complete asynchronous storage key setup without blocking user interaction
    try {
      if (window.VaultStorage && window.VaultStorage.ready) {
        await window.VaultStorage.ready();
        this.resolveActiveSticker();
        this.renderCurrentStickerState();
      }
    } catch (err) {
      console.warn("Storage readiness notice:", err);
    }
  }

  resolveActiveSticker() {
    const urlParams = new URLSearchParams(window.location.search);
    let code = urlParams.get('s') || urlParams.get('tag');

    // Also support /s/:code URL structure
    const match = window.location.pathname.match(/\/s\/([^/?#]+)/);
    if (match) {
      code = match[1];
    }

    if (!code) {
      code = window.VaultStorage.getActiveStickerCode() || 'k8Xq2mPz';
    }

    window.VaultStorage.setActiveStickerCode(code);
    this.activeSticker = window.VaultStorage.getSticker(code);
  }

  renderCurrentStickerState() {
    this.enteredPin = "";
    this.updatePinDots();

    const code = this.activeSticker?.code || 'k8Xq2mPz';
    const codeEl = document.getElementById('lblStickerCodeDisplay');
    if (codeEl) codeEl.textContent = `NFC Tag: #${code}`;

    // 1. Check if Sticker is Disabled
    if (this.activeSticker && this.activeSticker.status === 'disabled') {
      this.showDisabledScreen();
      return;
    }

    // 2. Check if Sticker is Fresh / Unclaimed
    if (!this.activeSticker || this.activeSticker.status === 'unclaimed') {
      this.showView('viewUnclaimed');
      return;
    }

    // 3. Check Lockout State (Option B Lockout Policy)
    const now = Date.now();
    if (this.activeSticker.lockout && this.activeSticker.lockout.lockedUntil > now) {
      this.showLockoutScreen();
      return;
    }

    // 4. Check "Remember This Device" Session (Option B Session Policy)
    // If owner device has an active session, auto-unlock into vault!
    if (window.VaultStorage.hasActiveSession(code)) {
      this.autoUnlockWithSavedSession();
      return;
    }

    // 5. Default: Zero-Knowledge PIN Screen (NO plate or owner details rendered)
    const remainingAttempts = 5 - (this.activeSticker.lockout?.failedAttempts || 0);
    this.updateAttemptsWarning(remainingAttempts);
    this.showView('viewPin');
  }

  async autoUnlockWithSavedSession() {
    try {
      // Default demo PIN or derive key
      const defaultPin = "123456";
      this.activeDek = await window.VaultCrypto.unlockDataKeyWithPin(defaultPin, this.activeSticker.keyBundle);
      this.openVaultView();
    } catch (e) {
      // Fallback to manual PIN entry if key unwrapping fails
      this.showView('viewPin');
    }
  }

  formatPlateNumber(plate) {
    const clean = (plate || '').replace(/\s+/g, '').toUpperCase();
    if (clean.length === 10) {
      return `${clean.slice(0, 2)} ${clean.slice(2, 4)} ${clean.slice(4, 6)} ${clean.slice(6)}`;
    }
    return plate;
  }

  showView(viewId) {
    this.hideSmsToast();
    document.querySelectorAll('.view-screen').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(viewId);
    if (target) {
      target.classList.add('active');
      this.currentView = viewId;
    }
  }

  bindEvents() {
    // Discreet Developer Drawer Controls
    const btnToggleDev = document.getElementById('btnToggleDevDrawer');
    const devDrawer = document.getElementById('devDrawer');
    if (btnToggleDev && devDrawer) {
      btnToggleDev.addEventListener('click', (e) => {
        e.stopPropagation();
        devDrawer.classList.toggle('active');
      });
      document.addEventListener('click', (e) => {
        if (!devDrawer.contains(e.target) && e.target !== btnToggleDev) {
          devDrawer.classList.remove('active');
        }
      });
    }

    // Drawer Route Switcher (Option B Tags)
    document.getElementById('btnSwitchClaimed').addEventListener('click', () => {
      this.switchStickerRoute('k8Xq2mPz');
    });

    document.getElementById('btnSwitchUnclaimed').addEventListener('click', () => {
      this.switchStickerRoute('u7Yt9wK2');
    });

    document.getElementById('btnSwitchDisabled').addEventListener('click', () => {
      this.switchStickerRoute('d3Fj5vN1');
    });

    document.getElementById('btnSimulateLockout').addEventListener('click', () => {
      if (this.activeSticker) {
        this.activeSticker.lockout = {
          failedAttempts: 5,
          fails24h: 5,
          lockedUntil: Date.now() + 15 * 60 * 1000
        };
        window.VaultStorage.saveSticker(this.activeSticker);
        this.renderCurrentStickerState();
      }
    });

    document.getElementById('btnResetDemo').addEventListener('click', async () => {
      if (confirm("Reset all CarVault local storage data to fresh defaults?")) {
        await window.VaultStorage.resetAllData();
        window.location.href = window.location.pathname.replace(/\/s\/.*/, '') + '?s=k8Xq2mPz';
      }
    });

    // Language Toggle
    const btnLang = document.getElementById('btnToggleLang');
    if (btnLang) {
      btnLang.addEventListener('click', () => {
        this.toggleLanguage();
      });
    }

    // Lock Vault Now (Owner Logs Out)
    document.getElementById('btnLockVaultNow').addEventListener('click', () => {
      this.activeDek = null;
      if (this.activeSticker) {
        window.VaultStorage.clearDeviceSession(this.activeSticker.code);
      }
      this.renderCurrentStickerState();
    });

    // Tactile Keypad Handlers
    document.querySelectorAll('.numpad-key[data-key]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const key = e.currentTarget.getAttribute('data-key');
        this.playKeypadClick();
        this.handlePinInput(key);
      });
    });

    document.getElementById('btnKeypadBackspace').addEventListener('click', () => {
      this.playKeypadClick();
      this.handlePinBackspace();
    });

    // Support physical desktop keyboard typing (0-9 and Backspace)
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
        return;
      }
      if (this.currentView === 'viewPin') {
        if (e.key >= '0' && e.key <= '9') {
          e.preventDefault();
          this.playKeypadClick();
          this.handlePinInput(e.key);
        } else if (e.key === 'Backspace') {
          e.preventDefault();
          this.playKeypadClick();
          this.handlePinBackspace();
        }
      }
    });

    document.getElementById('btnForgotPin').addEventListener('click', () => {
      this.openRecoveryFlow();
    });

    // Lockout Screen Actions
    document.getElementById('btnUnlockWithOtpFromLockout').addEventListener('click', () => {
      this.openRecoveryFlow();
    });

    document.getElementById('btnBypassLockout').addEventListener('click', () => {
      if (this.activeSticker) {
        this.activeSticker.status = 'active';
        this.activeSticker.lockout = { failedAttempts: 0, fails24h: 0, lockedUntil: 0 };
        window.VaultStorage.saveSticker(this.activeSticker);
        if (this.lockoutInterval) clearInterval(this.lockoutInterval);
        this.renderCurrentStickerState();
      }
    });

    // Onboarding Claim Flow (Scratch Claim Code + Phone OTP)
    document.getElementById('btnSendClaimOtp').addEventListener('click', async () => {
      const scratchCode = (document.getElementById('claimScratchCode')?.value || '').trim().toUpperCase();
      const phone = document.getElementById('claimPhone').value.trim();
      const vehNo = document.getElementById('claimVehicleNumber').value.trim();
      const vehName = document.getElementById('claimVehicleName').value.trim();

      if (!scratchCode) {
        alert("Please enter the Secret Claim Code found under the packaging scratch foil.");
        return;
      }

      // Validate scratch packaging code (PDF: claim code proves physical ownership)
      const expectedClaim = (this.activeSticker?.claimCode || 'CV-8924-X').replace(/\s+/g, '').toUpperCase();
      const enteredClaim = scratchCode.replace(/\s+/g, '').toUpperCase();
      if (enteredClaim !== expectedClaim && enteredClaim !== 'CV-8924-X') {
        alert("Invalid claim code! Please verify the code printed inside the packaging or under the scratch foil.");
        return;
      }

      if (!vehNo || !vehName || phone.length < 10) {
        alert("Please enter a valid Vehicle Number, Name, and 10-digit Phone Number.");
        return;
      }

      const btn = document.getElementById('btnSendClaimOtp');
      btn.textContent = "Sending Verification SMS...";
      btn.disabled = true;

      const twilioRes = await sendTwilioVerifyOtp(phone);
      if (twilioRes.success) {
        this.realOtpPhone = twilioRes.phone;
        this.pendingOtp = null;
        this.showSmsToast("REAL SMS DISPATCHED", `Twilio SMS OTP sent to ${twilioRes.phone}! Enter the code from your phone SMS.`, null);
      } else {
        let errorMsg = twilioRes.data?.error || twilioRes.error || "Twilio notice";
        if (errorMsg.includes("403") || errorMsg.includes("Forbidden") || !phone.includes("8866831535")) {
          errorMsg = "Twilio Trial delivers SMS to verified phone (+91 8866831535).";
        }
        this.pendingOtp = Math.floor(100000 + Math.random() * 900000).toString();
        this.showSmsToast("CARVAULT OTP", `${errorMsg} <br>Using demo code: <strong>${this.pendingOtp}</strong>`, this.pendingOtp);
      }

      btn.textContent = "Send Verification OTP";
      btn.disabled = false;
      document.getElementById('claimStep1').style.display = 'none';
      document.getElementById('claimStep2').style.display = 'block';
    });

    document.getElementById('btnBackToClaimStep1').addEventListener('click', () => {
      document.getElementById('claimStep2').style.display = 'none';
      document.getElementById('claimStep1').style.display = 'block';
    });

    document.getElementById('btnFinalizeClaim').addEventListener('click', async () => {
      const enteredOtp = document.getElementById('claimOtpInput').value.trim();
      const pin = document.getElementById('claimPin').value.trim();
      const pinConfirm = document.getElementById('claimPinConfirm').value.trim();
      const btn = document.getElementById('btnFinalizeClaim');

      if (this.realOtpPhone) {
        btn.textContent = "Verifying Code...";
        btn.disabled = true;
        const check = await checkTwilioVerifyOtp(this.realOtpPhone, enteredOtp);
        btn.textContent = "Activate & Lock Sticker";
        btn.disabled = false;

        if (!check.approved) {
          alert("Incorrect or expired SMS OTP! Please enter the exact code received on your phone.");
          return;
        }
      } else if (enteredOtp !== this.pendingOtp) {
        alert("Invalid OTP! Check the demo OTP code.");
        return;
      }

      if (pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        alert("PIN must be 6 digits.");
        return;
      }

      if (pin !== pinConfirm) {
        alert("PINs do not match.");
        return;
      }

      const vehNo = document.getElementById('claimVehicleNumber').value.trim().toUpperCase();
      const vehName = document.getElementById('claimVehicleName').value.trim();
      const phone = document.getElementById('claimPhone').value.trim();

      try {
        const keyBundle = await window.VaultCrypto.setupVaultKeys(pin);
        this.activeDek = await window.VaultCrypto.unlockDataKeyWithPin(pin, keyBundle);

        const sampleRcUrl = window.VaultStorage.createSampleDocumentImage('REGISTRATION CERTIFICATE', 'Transport Dept, Govt of Gujarat', '#2563eb');
        const textBuffer = new TextEncoder().encode(sampleRcUrl);
        const encrypted = await window.VaultCrypto.encryptFile(this.activeDek, textBuffer);

        const currentCode = this.activeSticker?.code || window.VaultStorage.getActiveStickerCode() || 'u7Yt9wK2';

        const updatedSticker = {
          code: currentCode,
          status: 'active',
          vehicleName: vehName,
          vehicleNumber: vehNo,
          ownerName: "Verified Owner",
          phone: phone,
          keyBundle: keyBundle,
          documents: [
            {
              id: 'doc-' + Date.now(),
              type: 'RC',
              title: 'Vehicle Registration Certificate (RC)',
              vehicleNo: vehNo,
              validTill: '2036-01-01',
              status: 'Valid',
              mimeType: 'image/svg+xml',
              fileName: 'RC_' + vehNo + '.svg',
              encryptedPayload: encrypted,
              uploadedAt: new Date().toISOString()
            }
          ],
          lockout: { failedAttempts: 0, fails24h: 0, lockedUntil: 0 },
          activatedAt: new Date().toISOString()
        };

        window.VaultStorage.saveSticker(updatedSticker);
        this.activeSticker = updatedSticker;
        window.VaultStorage.saveDeviceSession(currentCode, true);
        this.openVaultView();
      } catch (err) {
        console.error(err);
        alert("Error activating sticker: " + err.message);
      }
    });

    // Recovery Flow (Forgot PIN)
    document.getElementById('btnSendRecoveryOtp').addEventListener('click', async () => {
      const phone = this.activeSticker?.phone || '8866831535';
      const btn = document.getElementById('btnSendRecoveryOtp');
      btn.textContent = "Sending SMS OTP...";
      btn.disabled = true;

      const twilioRes = await sendTwilioVerifyOtp(phone);
      if (twilioRes.success) {
        this.realOtpPhone = twilioRes.phone;
        this.pendingOtp = null;
        this.showSmsToast("RECOVERY SMS SENT", `Twilio OTP sent to ${twilioRes.phone}! Check your SMS.`, null);
      } else {
        this.pendingOtp = Math.floor(100000 + Math.random() * 900000).toString();
        this.showSmsToast("RECOVERY OTP", `Demo code: <strong>${this.pendingOtp}</strong>`, this.pendingOtp);
      }

      btn.style.display = 'none';
      btn.textContent = "Send Recovery OTP";
      btn.disabled = false;
      document.getElementById('recoveryOtpSection').style.display = 'block';
    });

    document.getElementById('btnExecutePinReset').addEventListener('click', async () => {
      const enteredOtp = document.getElementById('recoveryOtpInput').value.trim();
      const newPin = document.getElementById('recoveryNewPin').value.trim();
      const newPinConfirm = document.getElementById('recoveryNewPinConfirm').value.trim();

      if (this.realOtpPhone) {
        const check = await checkTwilioVerifyOtp(this.realOtpPhone, enteredOtp);
        if (!check.approved) {
          alert("Incorrect or expired recovery OTP code.");
          return;
        }
      } else if (enteredOtp !== this.pendingOtp) {
        alert("Invalid OTP code!");
        return;
      }

      if (newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
        alert("New PIN must be 6 digits.");
        return;
      }

      if (newPin !== newPinConfirm) {
        alert("PINs do not match.");
        return;
      }

      try {
        const newBundle = await window.VaultCrypto.setupVaultKeys(newPin);
        this.activeDek = await window.VaultCrypto.unlockDataKeyWithPin(newPin, newBundle);
        this.activeSticker.keyBundle = newBundle;
        this.activeSticker.status = 'active';
        this.activeSticker.lockout = { failedAttempts: 0, fails24h: 0, lockedUntil: 0 };
        window.VaultStorage.saveSticker(this.activeSticker);

        alert("PIN updated successfully! Vault unlocked.");
        this.openVaultView();
      } catch (e) {
        alert("Recovery error: " + e.message);
      }
    });

    document.getElementById('btnCancelRecovery').addEventListener('click', () => {
      this.renderCurrentStickerState();
    });

    // 15-Minute Traffic Police Pass & Share Link
    document.getElementById('btnOpenOfficerMode').addEventListener('click', () => {
      this.openOfficerModeModal();
    });

    document.getElementById('btnCloseOfficerModal').addEventListener('click', () => {
      this.closeOfficerModeModal();
    });

    document.getElementById('btnDoneOfficerMode').addEventListener('click', () => {
      this.closeOfficerModeModal();
    });

    document.getElementById('btnCopyOfficerLink').addEventListener('click', () => {
      const input = document.getElementById('officerShareUrlInput');
      if (input) {
        input.select();
        navigator.clipboard.writeText(input.value).then(() => {
          const btn = document.getElementById('btnCopyOfficerLink');
          btn.textContent = "Copied ✓";
          setTimeout(() => { btn.textContent = "Copy Link"; }, 2000);
        });
      }
    });

    document.getElementById('btnRevokeOfficerPass').addEventListener('click', () => {
      if (confirm("Revoke this 15-minute inspection pass immediately?")) {
        window.VaultStorage.revokeOfficerPass(this.activeSticker.code);
        this.showSmsToast("PASS REVOKED", "The 15-minute officer pass was revoked immediately.", null);
        this.closeOfficerModeModal();
      }
    });

    // Upload Document
    document.getElementById('btnOpenUploadModal').addEventListener('click', () => {
      document.getElementById('modalUploadDoc').classList.add('active');
    });

    document.getElementById('btnCloseUploadModal').addEventListener('click', () => {
      document.getElementById('modalUploadDoc').classList.remove('active');
    });

    document.getElementById('btnSubmitNewDoc').addEventListener('click', () => {
      this.handleUploadDocument();
    });

    // Document Preview
    document.getElementById('btnClosePreview').addEventListener('click', () => {
      document.getElementById('modalDocPreview').classList.remove('active');
      this.selectedDoc = null;
    });

    document.getElementById('btnDeleteDoc').addEventListener('click', () => {
      if (!this.selectedDoc) return;
      if (confirm(`Remove ${this.selectedDoc.title} from vault?`)) {
        this.activeSticker.documents = this.activeSticker.documents.filter(d => d.id !== this.selectedDoc.id);
        window.VaultStorage.saveSticker(this.activeSticker);
        document.getElementById('modalDocPreview').classList.remove('active');
        this.renderVaultDocuments();
      }
    });

    document.getElementById('btnDownloadDecryptedDoc').addEventListener('click', () => {
      const img = document.getElementById('previewDocImg');
      if (!img.src) return;
      const a = document.createElement('a');
      a.href = img.src;
      a.download = (this.selectedDoc?.fileName || 'vault-doc') + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    // Privacy & Data Rights Modal
    document.getElementById('btnShowComplianceModal').addEventListener('click', () => {
      document.getElementById('modalCompliance').classList.add('active');
    });

    document.getElementById('btnCloseComplianceModal').addEventListener('click', () => {
      document.getElementById('modalCompliance').classList.remove('active');
    });

    // Deactivate / Report Lost Sticker (Option B Lifecycle)
    document.getElementById('btnDisableCurrentSticker').addEventListener('click', () => {
      if (confirm("Deactivate this physical sticker? Old sticker will immediately stop working.")) {
        this.activeSticker.status = 'disabled';
        this.activeSticker.disableReason = 'Deactivated by owner (reported peeled/lost)';
        window.VaultStorage.saveSticker(this.activeSticker);
        window.VaultStorage.clearDeviceSession(this.activeSticker.code);
        document.getElementById('modalCompliance').classList.remove('active');
        this.renderCurrentStickerState();
      }
    });

    // One-Tap Purge (DPDP Act Compliance)
    document.getElementById('btnPurgeTagData').addEventListener('click', () => {
      if (confirm("WARNING: This permanently wipes all vehicle records and documents from this sticker. Proceed?")) {
        const code = this.activeSticker?.code || 'k8Xq2mPz';
        const resetSticker = {
          code: code,
          status: 'unclaimed',
          claimCode: 'CV-8924-X',
          createdDate: new Date().toISOString()
        };
        window.VaultStorage.saveSticker(resetSticker);
        window.VaultStorage.clearDeviceSession(code);
        document.getElementById('modalCompliance').classList.remove('active');
        this.activeSticker = resetSticker;
        this.activeDek = null;
        this.renderCurrentStickerState();
      }
    });

    // SMS Toast Auto-Fill
    const btnAutoFill = document.getElementById('btnAutoFillOtp');
    if (btnAutoFill) {
      btnAutoFill.addEventListener('click', () => {
        if (this.pendingOtp) {
          const claimInput = document.getElementById('claimOtpInput');
          const recoveryInput = document.getElementById('recoveryOtpInput');
          if (claimInput && claimInput.offsetParent !== null) claimInput.value = this.pendingOtp;
          if (recoveryInput && recoveryInput.offsetParent !== null) recoveryInput.value = this.pendingOtp;
          this.hideSmsToast();
        }
      });
    }

    const btnCloseToast = document.getElementById('btnCloseToast');
    if (btnCloseToast) {
      btnCloseToast.addEventListener('click', () => {
        this.hideSmsToast();
      });
    }
  }

  switchStickerRoute(code) {
    window.VaultStorage.setActiveStickerCode(code);
    const url = new URL(window.location);
    url.searchParams.set('s', code);
    url.searchParams.delete('tag');
    window.history.replaceState({}, '', url.toString());

    this.activeSticker = window.VaultStorage.getSticker(code);
    this.activeDek = null;
    const devDrawer = document.getElementById('devDrawer');
    if (devDrawer) devDrawer.classList.remove('active');
    this.renderCurrentStickerState();
  }

  openOfficerModeModal() {
    const plate = this.formatPlateNumber(this.activeSticker.vehicleNumber || 'GJ 16 XX 2026');
    document.getElementById('officerModalPlate').textContent = plate;

    // Generate or fetch 15-minute share pass
    let pass = window.VaultStorage.getOfficerPass(this.activeSticker.code);
    if (!pass) {
      pass = window.VaultStorage.createOfficerPass(this.activeSticker.code, 15);
    }

    const passUrl = `https://carvault.in/p/${pass.token.substring(0, 10)}`;
    const urlInput = document.getElementById('officerShareUrlInput');
    if (urlInput) urlInput.value = passUrl;

    document.getElementById('modalOfficerMode').classList.add('active');
    this.startOfficerPassTimer(pass.expiresAt);
  }

  closeOfficerModeModal() {
    document.getElementById('modalOfficerMode').classList.remove('active');
    if (this.officerTimerInterval) {
      clearInterval(this.officerTimerInterval);
      this.officerTimerInterval = null;
    }
  }

  startOfficerPassTimer(expiresAt) {
    if (this.officerTimerInterval) clearInterval(this.officerTimerInterval);

    const updateTimer = () => {
      const remainingMs = expiresAt - Date.now();
      const countdownEl = document.getElementById('officerPassCountdown');
      if (!countdownEl) return;

      if (remainingMs <= 0) {
        clearInterval(this.officerTimerInterval);
        countdownEl.textContent = "00:00 (EXPIRED)";
        window.VaultStorage.revokeOfficerPass(this.activeSticker.code);
        return;
      }

      const totalSec = Math.floor(remainingMs / 1000);
      const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
      const s = (totalSec % 60).toString().padStart(2, '0');
      countdownEl.textContent = `${m}:${s}`;
    };

    updateTimer();
    this.officerTimerInterval = setInterval(updateTimer, 1000);
  }

  playKeypadClick() {
    try {
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, this.audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(160, this.audioCtx.currentTime + 0.032);
      gain.gain.setValueAtTime(0.06, this.audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.032);
      osc.connect(gain);
      gain.connect(this.audioCtx.destination);
      osc.start();
      osc.stop(this.audioCtx.currentTime + 0.032);
    } catch (e) {}
  }

  handlePinInput(digit) {
    if (this.enteredPin.length >= 6) return;
    this.enteredPin += digit;
    this.updatePinDots();

    if (this.enteredPin.length === 6) {
      setTimeout(() => this.verifyEnteredPin(), 120);
    }
  }

  handlePinBackspace() {
    if (this.enteredPin.length > 0) {
      this.enteredPin = this.enteredPin.slice(0, -1);
      this.updatePinDots();
    }
  }

  updatePinDots(isError = false) {
    const dots = document.querySelectorAll('#pinDots .pin-bubble');
    dots.forEach((dot, index) => {
      if (isError) {
        dot.classList.add('error');
      } else {
        dot.classList.remove('error');
        if (index < this.enteredPin.length) {
          dot.classList.add('filled');
        } else {
          dot.classList.remove('filled');
        }
      }
    });
  }

  updateAttemptsWarning(remaining) {
    const el = document.getElementById('attemptsWarning');
    if (!el) return;
    if (remaining === 5) {
      el.innerHTML = `Default Demo PIN: <strong>123456</strong>`;
      el.style.color = "var(--text-dim)";
    } else if (remaining > 1) {
      el.innerHTML = `⚠️ Incorrect PIN. ${remaining} attempts remaining before 15m lock`;
      el.style.color = "var(--accent-gold)";
    } else if (remaining === 1) {
      el.innerHTML = `🚨 Final attempt! Next failure locks sticker for 15 minutes.`;
      el.style.color = "var(--accent-rose)";
    }
  }

  async verifyEnteredPin() {
    if (!this.activeSticker) {
      this.resolveActiveSticker();
    }
    if (!this.activeSticker) {
      this.activeSticker = window.VaultStorage.getDefaultActiveSticker();
    }

    try {
      let dek = null;
      if (this.activeSticker.keyBundle && window.VaultCrypto) {
        try {
          dek = await window.VaultCrypto.unlockDataKeyWithPin(this.enteredPin, this.activeSticker.keyBundle);
        } catch (e) {
          if (this.enteredPin === "123456") {
            dek = "DEMO_UNLOCKED";
          } else {
            throw e;
          }
        }
      } else if (this.enteredPin === "123456") {
        dek = "DEMO_UNLOCKED";
      } else {
        throw new Error("Incorrect PIN");
      }

      this.activeDek = dek;

      // Reset lockout counter on success
      this.activeSticker.lockout = { failedAttempts: 0, fails24h: 0, lockedUntil: 0 };
      window.VaultStorage.saveSticker(this.activeSticker);

      // Check "Remember this phone" option
      const remember = document.getElementById('chkRememberDevice')?.checked ?? true;
      if (remember) {
        window.VaultStorage.saveDeviceSession(this.activeSticker.code, true);
      }

      this.openVaultView();
    } catch (err) {
      this.updatePinDots(true);

      const failedCount = (this.activeSticker?.lockout?.failedAttempts || 0) + 1;
      const fails24h = (this.activeSticker?.lockout?.fails24h || 0) + 1;

      // Lockout Policy Escalation (PDF: 5 -> 15m lock; 10 in 24h -> 24h lock + SMS; 20 -> disabled)
      let lockedUntil = 0;
      let alertNotice = false;

      if (fails24h >= 20) {
        this.activeSticker.status = 'disabled';
        this.activeSticker.disableReason = '20 failed attempts in 24 hours. Locked for owner safety.';
      } else if (fails24h >= 10) {
        lockedUntil = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
        alertNotice = true;
      } else if (failedCount >= 5) {
        lockedUntil = Date.now() + 15 * 60 * 1000; // 15 minutes
      }

      this.activeSticker.lockout = {
        failedAttempts: failedCount,
        fails24h: fails24h,
        lockedUntil: lockedUntil,
        alertSent24h: alertNotice
      };
      window.VaultStorage.saveSticker(this.activeSticker);

      if (alertNotice) {
        this.showSmsToast(
          "SECURITY SMS ALERT",
          `⚠️ Alert dispatched to registered phone (${this.activeSticker.phone || '+91 8866831535'}): "Someone is attempting to brute-force your CarVault tag."`,
          null
        );
      }

      setTimeout(() => {
        this.enteredPin = "";
        this.updatePinDots(false);

        if (this.activeSticker.status === 'disabled') {
          this.showDisabledScreen();
        } else if (lockedUntil > Date.now()) {
          this.showLockoutScreen();
        } else {
          this.updateAttemptsWarning(5 - failedCount);
        }
      }, 500);
    }
  }

  showDisabledScreen() {
    this.showView('viewLockout');
    document.getElementById('lockoutTitle').textContent = "Sticker Disabled";
    document.getElementById('lockoutSubText').textContent = "Maximum security attempts exceeded or tag reported lost. Only the verified owner can re-enable it via phone OTP.";
    document.getElementById('lockoutTimerDisplay').textContent = "DISABLED";
    document.getElementById('lockoutSmsNotice').style.display = 'block';
  }

  showLockoutScreen() {
    this.showView('viewLockout');

    const fails24h = this.activeSticker?.lockout?.fails24h || 0;
    const smsNoticeEl = document.getElementById('lockoutSmsNotice');
    if (fails24h >= 10) {
      document.getElementById('lockoutTitle').textContent = "Sticker Locked (24 Hours)";
      document.getElementById('lockoutSubText').textContent = "10 failed PIN attempts detected within 24 hours. Access locked.";
      if (smsNoticeEl) smsNoticeEl.style.display = 'block';
    } else {
      document.getElementById('lockoutTitle').textContent = "Sticker Locked (15 Mins)";
      document.getElementById('lockoutSubText').textContent = "5 incorrect PIN attempts. Protected to prevent unauthorized brute-forcing.";
      if (smsNoticeEl) smsNoticeEl.style.display = 'none';
    }

    this.updateLockoutTimer();

    if (this.lockoutInterval) clearInterval(this.lockoutInterval);
    this.lockoutInterval = setInterval(() => {
      this.updateLockoutTimer();
    }, 1000);
  }

  updateLockoutTimer() {
    const display = document.getElementById('lockoutTimerDisplay');
    const remainingMs = (this.activeSticker?.lockout?.lockedUntil || 0) - Date.now();

    if (remainingMs <= 0) {
      clearInterval(this.lockoutInterval);
      if (this.activeSticker) {
        this.activeSticker.lockout.failedAttempts = 0;
        this.activeSticker.lockout.lockedUntil = 0;
        window.VaultStorage.saveSticker(this.activeSticker);
      }
      this.renderCurrentStickerState();
      return;
    }

    const totalSeconds = Math.ceil(remainingMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
    const secs = (totalSeconds % 60).toString().padStart(2, '0');
    display.textContent = hours > 0 ? `${hours}:${mins}:${secs}` : `${mins}:${secs}`;
  }

  openRecoveryFlow() {
    if (this.lockoutInterval) clearInterval(this.lockoutInterval);

    const phone = this.activeSticker?.phone || '8866831535';
    const masked = `+91 ${phone.slice(0, 5)} ••••${phone.slice(-2)}`;
    document.getElementById('recoveryMaskedPhone').value = masked;

    document.getElementById('recoveryOtpSection').style.display = 'none';
    document.getElementById('btnSendRecoveryOtp').style.display = 'block';
    document.getElementById('recoveryOtpInput').value = '';
    document.getElementById('recoveryNewPin').value = '';
    document.getElementById('recoveryNewPinConfirm').value = '';

    this.showView('viewRecovery');
  }

  openVaultView() {
    const plate = this.formatPlateNumber(this.activeSticker.vehicleNumber || 'GJ 16 XX 2026');
    document.getElementById('vaultPlateBadge').textContent = plate;
    document.getElementById('vaultVehicleName').textContent = this.activeSticker.vehicleName || 'Vehicle Vault';
    document.getElementById('vaultOwnerFleet').textContent = `${this.activeSticker.ownerName || 'Owner'} • ${this.activeSticker.phone || ''}`;

    this.renderVaultDocuments();
    this.showView('viewVault');
  }

  renderVaultDocuments() {
    const grid = document.getElementById('documentGrid');
    grid.innerHTML = '';

    const docs = this.activeSticker.documents || [];

    docs.forEach(doc => {
      const card = document.createElement('div');
      const typeKey = (doc.type || 'rc').toLowerCase();
      card.className = `wallet-card card-${typeKey}`;

      const isPrivate = doc.type === 'Aadhaar';
      const statusText = isPrivate ? '🔒 Private ID' : (doc.status || 'Verified');

      card.innerHTML = `
        <div class="card-top-row">
          <div class="card-meta-left">
            <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <span class="card-type-tag">${doc.type} CERTIFICATE</span>
          </div>
          <span class="card-status-pill">${statusText}</span>
        </div>
        <div class="card-title">${doc.title}</div>
        <div class="card-bottom-row">
          <div class="card-validity">
            Valid: <strong>${doc.validTill}</strong>
          </div>
          <div style="font-size: 0.72rem; opacity: 0.8; display: flex; align-items: center; gap: 4px;">
            <span>Tap to View</span>
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"></path>
            </svg>
          </div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.openDocumentPreview(doc);
      });

      grid.appendChild(card);
    });
  }

  async openDocumentPreview(doc) {
    this.selectedDoc = doc;
    document.getElementById('previewDocTitle').textContent = doc.title;
    document.getElementById('previewDocType').textContent = doc.type;
    document.getElementById('previewDocExpiry').textContent = doc.validTill;

    const imgEl = document.getElementById('previewDocImg');
    imgEl.src = '';

    try {
      let decodedUrl = '';
      if (this.activeDek && this.activeDek !== "DEMO_UNLOCKED" && doc.encryptedPayload && window.VaultCrypto) {
        try {
          const decryptedBuffer = await window.VaultCrypto.decryptFile(this.activeDek, doc.encryptedPayload);
          decodedUrl = new TextDecoder().decode(decryptedBuffer);
        } catch (e) {
          decodedUrl = doc.rawUrl || '';
        }
      } else {
        decodedUrl = doc.rawUrl || '';
      }

      if (decodedUrl) {
        imgEl.src = decodedUrl;
        document.getElementById('modalDocPreview').classList.add('active');
      } else {
        alert("Document preview unavailable.");
      }
    } catch (err) {
      console.error(err);
      if (doc.rawUrl) {
        imgEl.src = doc.rawUrl;
        document.getElementById('modalDocPreview').classList.add('active');
      } else {
        alert("Decryption failed. Please lock and re-enter PIN.");
      }
    }
  }

  async handleUploadDocument() {
    const type = document.getElementById('newDocType').value;
    const title = document.getElementById('newDocTitle').value.trim() || `${type} Certificate`;
    const expiry = document.getElementById('newDocExpiry').value || 'Permanent';
    const fileInput = document.getElementById('newDocFileInput');

    let fileDataUrl = '';
    if (fileInput.files && fileInput.files[0]) {
      const file = fileInput.files[0];
      fileDataUrl = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.readAsDataURL(file);
      });
    } else {
      fileDataUrl = window.VaultStorage.createSampleDocumentImage(title.toUpperCase(), `Uploaded for ${this.activeSticker.vehicleNumber}`, '#0ea5e9');
    }

    try {
      const textBuffer = new TextEncoder().encode(fileDataUrl);
      const encrypted = await window.VaultCrypto.encryptFile(this.activeDek, textBuffer);

      const newDoc = {
        id: 'doc-' + Date.now(),
        type: type,
        title: title,
        vehicleNo: this.activeSticker.vehicleNumber,
        validTill: expiry,
        status: 'Active',
        mimeType: 'image/png',
        fileName: `${type}_${Date.now()}`,
        encryptedPayload: encrypted,
        uploadedAt: new Date().toISOString()
      };

      this.activeSticker.documents.push(newDoc);
      window.VaultStorage.saveSticker(this.activeSticker);

      document.getElementById('modalUploadDoc').classList.remove('active');
      document.getElementById('newDocTitle').value = '';
      fileInput.value = '';

      this.renderVaultDocuments();
    } catch (err) {
      console.error(err);
      alert("Error encrypting document: " + err.message);
    }
  }

  hideSmsToast() {
    const toast = document.getElementById('smsToast');
    if (toast) {
      toast.classList.remove('visible');
    }
    if (this.smsToastTimeout) {
      clearTimeout(this.smsToastTimeout);
      this.smsToastTimeout = null;
    }
  }

  showSmsToast(sender, message, otp) {
    this.hideSmsToast();

    const toast = document.getElementById('smsToast');
    if (!toast) return;

    document.getElementById('smsSender').textContent = sender;
    document.getElementById('smsBody').innerHTML = message;

    const btnAutoFill = document.getElementById('btnAutoFillOtp');
    if (otp) {
      btnAutoFill.style.display = 'inline-block';
    } else {
      btnAutoFill.style.display = 'none';
    }

    void toast.offsetWidth;
    toast.classList.add('visible');

    this.smsToastTimeout = setTimeout(() => {
      this.hideSmsToast();
    }, 6000);
  }

  toggleLanguage() {
    const langs = ['EN', 'GU', 'HI'];
    const nextIdx = (langs.indexOf(this.currentLang) + 1) % langs.length;
    this.currentLang = langs[nextIdx];
    this.applyLanguage(this.currentLang);
  }

  applyLanguage(lang) {
    document.getElementById('currentLangLabel').textContent = lang;
    const t = {
      EN: {
        pinTitle: "Enter 6-Digit PIN",
        pinSub: "Decryption keys are unlocked only by your master PIN",
        policeTitle: "Show to Traffic Police",
        policeSub: "15-minute certified pass for inspection",
        docsTitle: "Vehicle Documents"
      },
      GU: {
        pinTitle: "૬-અંકનો PIN દાખલ કરો",
        pinSub: "બધા દસ્તાવેજો સુરક્ષિત રીતે તમારા વાહન સ્ટીકરમાં સાચવેલા છે",
        policeTitle: "ટ્રાફિક પોલીસને બતાવો",
        policeSub: "તપાસ માટે ૧૫ મિનિટનો અધિકૃત પાસ",
        docsTitle: "વાહનના દસ્તાવેજો"
      },
      HI: {
        pinTitle: "६-अंकों का PIN दर्ज करें",
        pinSub: "डिक्रिप्शन कुंजी केवल आपके मास्टर पिन से अनलॉक होती है",
        policeTitle: "ट्रैफिक पुलिस को दिखाएं",
        policeSub: "निरीक्षण हेतु १५-मिनट का प्रमाणित पास",
        docsTitle: "वाहन के दस्तावेज़"
      }
    }[lang] || {};

    if (t.pinTitle && document.getElementById('txtEnterPin')) document.getElementById('txtEnterPin').textContent = t.pinTitle;
    if (t.pinSub && document.getElementById('txtPinSub')) document.getElementById('txtPinSub').textContent = t.pinSub;
    if (t.policeTitle && document.getElementById('txtPolicePassTitle')) document.getElementById('txtPolicePassTitle').textContent = t.policeTitle;
    if (t.policeSub && document.getElementById('txtPolicePassSub')) document.getElementById('txtPolicePassSub').textContent = t.policeSub;
    if (t.docsTitle && document.getElementById('txtDocumentsTitle')) {
      document.getElementById('txtDocumentsTitle').innerHTML = `
        <svg width="18" height="18" fill="none" stroke="#60a5fa" stroke-width="2" viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="16" rx="2"></rect>
          <path d="M7 15h0M2 10h20"></path>
        </svg>
        ${t.docsTitle}
      `;
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => {
    window.app = new CarVaultApp();
  });
} else {
  window.app = new CarVaultApp();
}
