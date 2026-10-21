/**
 * Cloudflare Worker for CarVault PWA
 * - Handles serverless Twilio Verify SMS dispatch & verification
 * - Passes all static assets through to Cloudflare Pages ASSETS binding
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Cache-Control": "no-cache, no-store, must-revalidate"
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const twilioAccountSid = env?.TWILIO_ACCOUNT_SID || "";
    const twilioAuthToken = env?.TWILIO_AUTH_TOKEN || "";
    const twilioVerifySid = env?.TWILIO_VERIFY_SID || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Send OTP via Twilio Verify
    if (url.pathname === "/api/send-otp" && request.method === "POST") {
      try {
        const body = await request.json();
        let phone = (body.phone || "").replace(/\s+/g, "");
        if (!phone.startsWith("+")) {
          phone = "+91" + phone.replace(/^0+/, "");
        }

        if (!twilioAccountSid || !twilioAuthToken || !twilioVerifySid) {
          // Demo fallback response if credentials are not set in environment
          return new Response(JSON.stringify({ success: true, status: "pending", demo: true, phone }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const twilioUrl = `https://verify.twilio.com/v2/Services/${twilioVerifySid}/Verifications`;
        const params = new URLSearchParams();
        params.append("To", phone);
        params.append("Channel", "sms");

        const authHeader = "Basic " + btoa(`${twilioAccountSid}:${twilioAuthToken}`);
        const twilioRes = await fetch(twilioUrl, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: params.toString()
        });

        const data = await twilioRes.json();
        if (twilioRes.ok) {
          return new Response(JSON.stringify({ success: true, status: data.status, phone }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ success: false, error: data.message || "Twilio error" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 2. Check OTP via Twilio Verify
    if (url.pathname === "/api/check-otp" && request.method === "POST") {
      try {
        const body = await request.json();
        let phone = (body.phone || "").replace(/\s+/g, "");
        if (!phone.startsWith("+")) {
          phone = "+91" + phone.replace(/^0+/, "");
        }
        const code = String(body.code || "").trim();

        if (!twilioAccountSid || !twilioAuthToken || !twilioVerifySid) {
          // Demo fallback
          return new Response(JSON.stringify({ success: true, approved: true, status: "approved", demo: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const twilioUrl = `https://verify.twilio.com/v2/Services/${twilioVerifySid}/VerificationCheck`;
        const params = new URLSearchParams();
        params.append("To", phone);
        params.append("Code", code);

        const authHeader = "Basic " + btoa(`${twilioAccountSid}:${twilioAuthToken}`);
        const twilioRes = await fetch(twilioUrl, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: params.toString()
        });

        const data = await twilioRes.json();
        const isApproved = data.status === "approved";
        return new Response(JSON.stringify({ success: true, approved: isApproved, status: data.status }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: true, approved: false, error: "Verification failed" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // 3. Static asset passthrough (Cloudflare Pages) with SPA routing for /s/:code
    if (env && env.ASSETS) {
      let targetReq = request;
      // Only rewrite /s/:code if it doesn't have a static file extension (e.g. .js, .css, .png)
      if (url.pathname.startsWith("/s/") && !/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
        targetReq = new Request(new URL("/", request.url), request);
      }
      const assetRes = await env.ASSETS.fetch(targetReq);
      const newHeaders = new Headers(assetRes.headers);
      newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      return new Response(assetRes.body, {
        status: assetRes.status,
        statusText: assetRes.statusText,
        headers: newHeaders
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
