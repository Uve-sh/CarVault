# CarVault — Option B Technical Implementation

CarVault is an NFC sticker on a vehicle that opens a password-protected vault of the owner's vehicle and driving documents.

**Architecture Locked:** Option B — Unique URL per sticker (`carvault.in/s/<8-char-code>`).

---

## 🔒 Core Architecture & Decisions

1. **One Backend, Zero Dynamic QR Middleware**:
   The sticker holds a plain link (`carvault.in/s/:code`). The sticker code points straight to the vehicle record in the database.
2. **Zero-Knowledge Public Gate**:
   Anyone can tap a sticker on a parked windshield. Therefore, **no owner name, no plate number, and no hints** are revealed before the master PIN is verified.
3. **Escalating Lockout Policy**:
   - **1–4 wrong attempts**: Uniform 1-second delay + generic error message.
   - **5 wrong attempts**: 15-minute cooldown timer (`15:00`).
   - **10 wrong attempts (in 24h)**: 24-hour lock + SMS alert sent to registered owner phone.
   - **20 wrong attempts (in 24h)**: Permanent sticker disable (`status = 'disabled'`).
4. **"Remember This Device" Session**:
   Successful unlock with "Remember this device" stores a 30-day session token, letting the vehicle owner tap and skip password entry on their own phone. Untrusted devices expire after 15 minutes.
5. **15-Minute Officer Pass & Share Links**:
   When stopped by traffic police, the owner generates a view-only inspection pass with an auto-expiring 15:00 countdown timer and a 1-tap "Revoke Now" emergency button. The owner never hands over their master PIN.
6. **Scratch Packaging Claim Code**:
   Fresh stickers require entering the secret scratch claim code (e.g. `CV-8924-X`) found inside the physical packaging, proving physical ownership before binding to a vehicle.

---

## 🗄️ Database Model (7 PostgreSQL / Supabase Tables)

```sql
-- 1. Users
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    deleted_at TIMESTAMPTZ DEFAULT NULL
);

-- 2. Vehicles
CREATE TABLE vehicles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plate VARCHAR(20) NOT NULL,
    make_model VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Stickers (Option B: One route per tag)
CREATE TABLE stickers (
    code VARCHAR(16) PRIMARY KEY,
    claim_code_hash TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'unclaimed', -- 'unclaimed', 'active', 'disabled'
    vehicle_id UUID REFERENCES vehicles(id) ON DELETE SET NULL,
    activated_at TIMESTAMPTZ DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Documents (Metadata only, files in private storage)
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL, -- 'RC', 'insurance', 'PUC', 'DL', 'other'
    file_path TEXT NOT NULL,
    expiry_date DATE,
    uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Share Links (15-min view-only officer passes)
CREATE TABLE share_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL UNIQUE,
    vehicle_id UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
    document_ids UUID[] NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Login Attempts (Brute force & lockout tracking)
CREATE TABLE login_attempts (
    id BIGSERIAL PRIMARY KEY,
    sticker_code VARCHAR(16) NOT NULL REFERENCES stickers(code) ON DELETE CASCADE,
    ip_address INET NOT NULL,
    success BOOLEAN NOT NULL DEFAULT FALSE,
    attempted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Audit Log
CREATE TABLE audit_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(20) NOT NULL,
    document_id UUID REFERENCES documents(id) ON DELETE SET NULL,
    ip_address INET,
    logged_at TIMESTAMPTZ DEFAULT NOW()
);
```

---

## 🏃 Running the Prototype Locally

Start the local server:
```powershell
powershell -ExecutionPolicy Bypass -File .\server.ps1
```
Open:
👉 **[http://127.0.0.1:8080/](http://127.0.0.1:8080/)**

### Demo Routes (Option B Tags):
- **Active Sticker**: `http://127.0.0.1:8080/?s=k8Xq2mPz` (Default PIN: `123456`)
- **Unclaimed Tag**: `http://127.0.0.1:8080/?s=u7Yt9wK2` (Claim code: `CV-8924-X`)
- **Disabled Tag**: `http://127.0.0.1:8080/?s=d3Fj5vN1` (Lockout limit reached)
