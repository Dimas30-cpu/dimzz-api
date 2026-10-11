export default async function handler(req, res) {
    // Tangkap path dari query dinamis Vercel (catch-all) atau fallback ke req.url
    const { path } = req.query;
    let requestedPath = '';

    if (path) {
        requestedPath = '/' + (Array.isArray(path) ? path.join('/') : path);
    } else {
        // Fallback parsing URL jika dipanggil langsung
        const parsedFullUrl = new URL(req.url, `https://${req.headers.host}`);
        requestedPath = parsedFullUrl.pathname;
    }

    // Normalisasi path (hapus trailing slash dan pastikan diawali slash tunggal)
    requestedPath = '/' + requestedPath.replace(/^\/+/, '').replace(/\/+$/, '');

    // Kompatibilitas mundur dengan proxy tester lama (POST {url})
    if (req.method === 'POST' && req.body && req.body.url && (requestedPath === '/' || requestedPath === '/api' || requestedPath === '/api/proxy')) {
        return handleLegacyProxy(req, res);
    }

    const binId = process.env.JSONBIN_BIN_ID || '6acb030dffd5d16053607ef6';
    const apiKey = process.env.JSONBIN_PUBLIC_KEY;

    try {
        const configRes = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
            headers: apiKey ? { 'X-Master-Key': apiKey } : {}
        });

        if (!configRes.ok) {
            throw new Error('Failed to fetch endpoint configurations from JSONBin');
        }

        const configData = await configRes.json();
        const endpoints = configData.record.endpoints || [];

        // Cari endpoint yang cocok berdasarkan slug atau path URL sumber
        const matchedEp = endpoints.find(ep => {
            // Pastikan boolean aktif dan publik benar-benar terpenuhi
            const isEnabled = ep.enabled === true || ep.enabled === 'true';
            const isPublic = ep.public === true || ep.public === 'true';
            if (!isEnabled || !isPublic) return false;

            // Normalisasi slug/path yang tersimpan di database admin
            let epSlug = ep.slug || '';
            if (!epSlug && ep.url) {
                try {
                    epSlug = new URL(ep.url).pathname;
                } catch (e) {
                    epSlug = '';
                }
            }
            epSlug = '/' + epSlug.replace(/^\/+/, '').replace(/\/+$/, '');

            // Bandingkan apakah path request sama dengan slug publik atau dengan awalan /api
            return requestedPath === epSlug || requestedPath === ('/api' + epSlug) || ('/api' + requestedPath) === epSlug;
        });

        if (!matchedEp) {
            return res.status(404).json({
                success: false,
                error: `Endpoint not found or disabled for path: ${requestedPath}`
            });
        }

        // Validasi HTTP Method
        if (matchedEp.method && matchedEp.method.toUpperCase() !== req.method.toUpperCase()) {
            return res.status(405).json({
                success: false,
                error: `Method ${req.method} not allowed. Expected ${matchedEp.method}`
            });
        }

        // Ambil URL sumber (mendukung properti 'url' maupun 'sourceUrl')
        const targetSourceUrl = matchedEp.url || matchedEp.sourceUrl;
        if (!targetSourceUrl) {
            return res.status(500).json({ success: false, error: 'Target source URL is not configured for this endpoint.' });
        }

        const targetUrlObj = new URL(targetSourceUrl);

        // Pindahkan seluruh parameter query string dari request pengguna ke URL sumber
        const incomingUrlObj = new URL(req.url, `https://${req.headers.host}`);
        incomingUrlObj.searchParams.forEach((value, key) => {
            targetUrlObj.searchParams.set(key, value);
        });

        const finalTargetUrl = targetUrlObj.toString();

        // Validasi Keamanan SSRF (Blokir IP lokal/internal)
        const hostname = targetUrlObj.hostname;
        if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname.startsWith('10.') ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('169.254.') ||
            !targetUrlObj.protocol.startsWith('https')
        ) {
            return res.status(403).json({ success: false, error: 'Forbidden: Target URL violates security policies.' });
        }

        // Eksekusi Request ke API Pihak Ketiga
        const startTime = Date.now();
        const fetchOptions = {
            method: matchedEp.method || 'GET',
            headers: {
                'User-Agent': 'DIMZZ-API-HUB-Secure-Proxy/2026',
                ...(matchedEp.headers || {})
            }
        };

        if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method)) {
            if (req.body && Object.keys(req.body).length > 0) {
                fetchOptions.headers['Content-Type'] = 'application/json';
                fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
            }
        }

        const externalRes = await fetch(finalTargetUrl, fetchOptions);
        const responseTime = Date.now() - startTime;
        const contentType = externalRes.headers.get('content-type') || '';

        let responseData;
        if (contentType.includes('application/json')) {
            responseData = await externalRes.json();
        } else {
            responseData = await externalRes.text();
        }

        return res.status(externalRes.status).json({
            success: externalRes.ok,
            status: externalRes.status,
            statusText: externalRes.statusText,
            responseTime,
            data: responseData
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

// Handler fallback untuk fitur lama
async function handleLegacyProxy(req, res) {
    const { url, method = 'GET', headers = {}, body = null } = req.body;
    try {
        const targetObj = new URL(url);
        if (['localhost', '127.0.0.1'].includes(targetObj.hostname)) {
            return res.status(403).json({ success: false, error: 'Forbidden target' });
        }
        const start = Date.now();
        const resp = await fetch(url, {
            method,
            headers: { 'User-Agent': 'DIMZZ-Legacy-Proxy', ...headers },
            body: body && ['POST', 'PUT', 'PATCH'].includes(method) ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
        });
        const contentType = resp.headers.get('content-type') || '';
        const data = contentType.includes('application/json') ? await resp.json() : await resp.text();
        return res.status(200).json({ success: resp.ok, status: resp.status, responseTime: Date.now() - start, data });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
}
