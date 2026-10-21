/**
 * WebCrypto Implementation for NFC Car Vault
 * Handles:
 * - PBKDF2 key derivation from 6-digit user PIN + unique salt
 * - AES-GCM 256-bit Data Encryption Key (DEK) generation
 * - Key wrapping (User PIN Key + Simulated Server Master Key)
 * - File encryption & decryption (AES-GCM)
 * - Server key re-wrapping on OTP reset
 */

class VaultCrypto {
  constructor() {
    // Simulated server master key (in production, kept in Cloudflare Workers / Secret Manager)
    this.SERVER_MASTER_SECRET = "CARVAULT_SRV_MASTER_KEY_SECRET_BHARUCH_2026_SECURE!";
  }

  // Convert string to Uint8Array
  stringToBytes(str) {
    return new TextEncoder().encode(str);
  }

  // Convert Uint8Array to Base64
  bytesToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Convert Base64 to Uint8Array
  base64ToBytes(base64) {
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  // Generate random bytes (for salt, IV)
  getRandomBytes(length = 16) {
    const bytes = new Uint8Array(length);
    window.crypto.getRandomValues(bytes);
    return bytes;
  }

  // Derive a Key Encryption Key (KEK) from PIN + Salt using PBKDF2
  async deriveKeyFromPin(pin, saltBytes) {
    const pinBytes = this.stringToBytes(pin);
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      pinBytes,
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );

    return await window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: 100000,
        hash: "SHA-256"
      },
      baseKey,
      { name: "AES-GCM", length: 256 },
      true,
      ["wrapKey", "unwrapKey", "encrypt", "decrypt"]
    );
  }

  // Derive Server Master KEK
  async deriveServerMasterKey() {
    const keyBytes = this.stringToBytes(this.SERVER_MASTER_SECRET);
    const hash = await window.crypto.subtle.digest("SHA-256", keyBytes);
    return await window.crypto.subtle.importKey(
      "raw",
      hash,
      { name: "AES-GCM" },
      false,
      ["wrapKey", "unwrapKey"]
    );
  }

  // Generate a new random Data Encryption Key (DEK)
  async generateDataKey() {
    return await window.crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
  }

  // Initialize a new user vault keys: generates DEK and wraps it twice
  async setupVaultKeys(pin) {
    const salt = this.getRandomBytes(16);
    const pinKek = await this.deriveKeyFromPin(pin, salt);
    const serverKek = await this.deriveServerMasterKey();

    // Generate user DEK
    const dek = await this.generateDataKey();

    // Wrap DEK with PIN KEK
    const userWrapIv = this.getRandomBytes(12);
    const wrappedByUser = await window.crypto.subtle.wrapKey(
      "raw",
      dek,
      pinKek,
      { name: "AES-GCM", iv: userWrapIv }
    );

    // Wrap DEK with Server Master KEK
    const serverWrapIv = this.getRandomBytes(12);
    const wrappedByServer = await window.crypto.subtle.wrapKey(
      "raw",
      dek,
      serverKek,
      { name: "AES-GCM", iv: serverWrapIv }
    );

    return {
      salt: this.bytesToBase64(salt),
      wrappedByUser: this.bytesToBase64(new Uint8Array(wrappedByUser)),
      userWrapIv: this.bytesToBase64(userWrapIv),
      wrappedByServer: this.bytesToBase64(new Uint8Array(wrappedByServer)),
      serverWrapIv: this.bytesToBase64(serverWrapIv)
    };
  }

  // Unlock DEK using user PIN
  async unlockDataKeyWithPin(pin, keyBundle) {
    const salt = this.base64ToBytes(keyBundle.salt);
    const pinKek = await this.deriveKeyFromPin(pin, salt);
    const wrappedData = this.base64ToBytes(keyBundle.wrappedByUser);
    const iv = this.base64ToBytes(keyBundle.userWrapIv);

    try {
      const dek = await window.crypto.subtle.unwrapKey(
        "raw",
        wrappedData,
        pinKek,
        { name: "AES-GCM", iv: iv },
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      return dek;
    } catch (err) {
      throw new Error("INCORRECT_PIN");
    }
  }

  // Server-side recovery: Unwrap DEK using Server Master Key, and re-wrap under new PIN
  async resetPinAndRewrapKeys(newPin, keyBundle) {
    const serverKek = await this.deriveServerMasterKey();
    const wrappedData = this.base64ToBytes(keyBundle.wrappedByServer);
    const iv = this.base64ToBytes(keyBundle.serverWrapIv);

    // Unwrap with server master key
    const dek = await window.crypto.subtle.unwrapKey(
      "raw",
      wrappedData,
      serverKek,
      { name: "AES-GCM", iv: iv },
      { name: "AES-GCM", length: 256 },
      true,
      ["wrapKey", "encrypt", "decrypt"]
    );

    // Re-wrap under new PIN
    const newSalt = this.getRandomBytes(16);
    const newPinKek = await this.deriveKeyFromPin(newPin, newSalt);
    const newUserWrapIv = this.getRandomBytes(12);
    const newWrappedByUser = await window.crypto.subtle.wrapKey(
      "raw",
      dek,
      newPinKek,
      { name: "AES-GCM", iv: newUserWrapIv }
    );

    return {
      ...keyBundle,
      salt: this.bytesToBase64(newSalt),
      wrappedByUser: this.bytesToBase64(new Uint8Array(newWrappedByUser)),
      userWrapIv: this.bytesToBase64(newUserWrapIv)
    };
  }

  // Encrypt raw file data (ArrayBuffer or string) using DEK
  async encryptFile(dek, fileBuffer) {
    const iv = this.getRandomBytes(12);
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv },
      dek,
      fileBuffer
    );

    return {
      ciphertext: this.bytesToBase64(new Uint8Array(ciphertext)),
      iv: this.bytesToBase64(iv),
      algorithm: "AES-256-GCM"
    };
  }

  // Decrypt ciphertext using DEK
  async decryptFile(dek, encryptedPayload) {
    const iv = this.base64ToBytes(encryptedPayload.iv);
    const ciphertext = this.base64ToBytes(encryptedPayload.ciphertext);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      dek,
      ciphertext
    );

    return decryptedBuffer;
  }
}

window.VaultCrypto = new VaultCrypto();
