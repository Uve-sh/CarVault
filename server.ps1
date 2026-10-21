$port = 8080
$prefix = "http://127.0.0.1:$port/"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Output "CarVault Server running at $prefix"

$baseDir = $PSScriptRoot

$twilioSid = if ($env:TWILIO_ACCOUNT_SID) { $env:TWILIO_ACCOUNT_SID } else { "" }
$twilioToken = if ($env:TWILIO_AUTH_TOKEN) { $env:TWILIO_AUTH_TOKEN } else { "" }
$twilioVerifySid = if ($env:TWILIO_VERIFY_SID) { $env:TWILIO_VERIFY_SID } else { "" }
$authHeader = if ($twilioSid -and $twilioToken) { "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("${twilioSid}:${twilioToken}")) } else { "" }

while ($listener.IsListening) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        $path = $request.Url.LocalPath

        $response.AddHeader("Access-Control-Allow-Origin", "*")
        $response.AddHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        $response.AddHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
        $response.AddHeader("Cache-Control", "no-cache, no-store, must-revalidate")
        $response.AddHeader("Pragma", "no-cache")
        $response.AddHeader("Expires", "0")

        if ($request.HttpMethod -eq "OPTIONS") {
            $response.StatusCode = 200
            $response.Close()
            continue
        }

        # Helper to read request body safely without blocking
        $readBodyJson = {
            param($req)
            $len = [int]$req.ContentLength64
            if ($len -gt 0) {
                $buf = New-Object byte[] $len
                $total = 0
                while ($total -lt $len) {
                    $chunk = $req.InputStream.Read($buf, $total, ($len - $total))
                    if ($chunk -le 0) { break }
                    $total += $chunk
                }
                $str = [System.Text.Encoding]::UTF8.GetString($buf, 0, $total)
                return ($str | ConvertFrom-Json)
            }
            return @{}
        }

        # API: Send OTP
        if ($path -eq "/api/send-otp" -and $request.HttpMethod -eq "POST") {
            $json = &$readBodyJson $request
            $phone = [string]($json.phone -replace "\s+","")
            if (-not $phone.StartsWith("+")) {
                $phone = "+91" + ($phone -replace "^0+","")
            }

            $body = @{
                To = $phone
                Channel = "sms"
            }
            $headers = @{ "Authorization" = $authHeader }

            $response.ContentType = "application/json"
            try {
                $twilioRes = Invoke-RestMethod -Uri "https://verify.twilio.com/v2/Services/$twilioVerifySid/Verifications" -Method Post -Headers $headers -Body $body
                $resBytes = [Text.Encoding]::UTF8.GetBytes((@{ success = $true; status = $twilioRes.status } | ConvertTo-Json))
                $response.ContentLength64 = $resBytes.Length
                $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
            } catch {
                $msg = $_.Exception.Message
                try {
                    $stream = $_.Exception.Response.GetResponseStream()
                    if ($stream) {
                        $reader = New-Object System.IO.StreamReader($stream)
                        $errData = $reader.ReadToEnd() | ConvertFrom-Json
                        if ($errData.message) { $msg = $errData.message }
                    }
                } catch {}
                $errBytes = [Text.Encoding]::UTF8.GetBytes((@{ success = $false; error = $msg } | ConvertTo-Json))
                $response.StatusCode = 400
                $response.ContentLength64 = $errBytes.Length
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
            }
            $response.Close()
            continue
        }

        # API: Check OTP
        if ($path -eq "/api/check-otp" -and $request.HttpMethod -eq "POST") {
            $json = &$readBodyJson $request
            $phone = [string]($json.phone -replace "\s+","")
            if (-not $phone.StartsWith("+")) {
                $phone = "+91" + ($phone -replace "^0+","")
            }
            $code = [string]($json.code).Trim()

            $headers = @{ 
                "Authorization" = $authHeader
                "Content-Type"  = "application/x-www-form-urlencoded"
            }
            $body = "To=" + [Uri]::EscapeDataString($phone) + "&Code=" + [Uri]::EscapeDataString($code)

            $response.ContentType = "application/json"
            try {
                $twilioRes = Invoke-RestMethod -Uri "https://verify.twilio.com/v2/Services/$twilioVerifySid/VerificationCheck" -Method Post -Headers $headers -Body $body
                $isApproved = ($twilioRes.status -eq "approved")
                $resBytes = [Text.Encoding]::UTF8.GetBytes((@{ success = $true; approved = $isApproved; status = $twilioRes.status } | ConvertTo-Json))
                $response.ContentLength64 = $resBytes.Length
                $response.OutputStream.Write($resBytes, 0, $resBytes.Length)
            } catch {
                $errBytes = [Text.Encoding]::UTF8.GetBytes((@{ success = $true; approved = $false; error = "Incorrect or expired OTP" } | ConvertTo-Json))
                $response.ContentLength64 = $errBytes.Length
                $response.OutputStream.Write($errBytes, 0, $errBytes.Length)
            }
            $response.Close()
            continue
        }

        # Static Files & SPA Routing for /s/:code
        $cleanPath = $path.TrimStart('/')

        # 1. Check if the path points directly to an existing file in $baseDir
        $filePath = Join-Path $baseDir $cleanPath

        # 2. If the request was made relative to /s/ (e.g. /s/js/app.js or /s/css/styles.css), strip leading "s/"
        if (-not (Test-Path $filePath -PathType Leaf) -and $cleanPath -match "^s/(.+)$") {
            $strippedPath = Join-Path $baseDir $matches[1]
            if (Test-Path $strippedPath -PathType Leaf) {
                $filePath = $strippedPath
            }
        }

        # 3. If path is empty or a SPA route (/s/:code without file extension), serve index.html
        if (-not (Test-Path $filePath -PathType Leaf)) {
            if ([string]::IsNullOrEmpty($cleanPath) -or $path -match "^/s/") {
                $filePath = Join-Path $baseDir "index.html"
            }
        }

        if (Test-Path $filePath -PathType Leaf) {
            $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
            $contentType = switch ($ext) {
                ".html" { "text/html; charset=utf-8" }
                ".css"  { "text/css; charset=utf-8" }
                ".js"   { "application/javascript; charset=utf-8" }
                ".json" { "application/json; charset=utf-8" }
                ".svg"  { "image/svg+xml" }
                ".png"  { "image/png" }
                ".ico"  { "image/x-icon" }
                default { "application/octet-stream" }
            }

            $response.ContentType = $contentType
            $bytes = [System.IO.File]::ReadAllBytes($filePath)
            $response.ContentLength64 = $bytes.Length
            if ($request.HttpMethod -ne "HEAD") {
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } else {
            $response.StatusCode = 404
            $buffer = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
            $response.ContentLength64 = $buffer.Length
            $response.OutputStream.Write($buffer, 0, $buffer.Length)
        }
        $response.Close()
    } catch {
        # Handle client disconnect
    }
}
