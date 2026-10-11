export default async function handler(req, res) {
    // 1. Ambil path dinamis dari query (hasil tangkapan catch-all vercel.json) atau URL path
    const { path } = req.query;
    const requestedPath = '/' + (Array.isArray(path) ? path.join('/') : (path || ''));

    // Kompatibilitas mundur dengan sistem proxy lama (POST langsung dengan body {url})
    if (req.method === 'POST' && req.body && req.body.url && requestedPath === '/') {
        return handleLegacyProxy(req, res);
    }

    const binId = process.env.JSONBIN_BIN_ID || '6acb030dffd5d16053607ef6';
    const apiKey = process.env.JSONBIN_PUBLIC_KEY;

    try {
        // 2. Ambil konfigurasi endpoint dari JSONBin
        const configRes = await fetch(`https://api.jsonbin.io/v3/b/${binId}/latest`, {
            headers: apiKey ? { 'X-Master-Key': apiKey } : {}
        });

        if (!configRes.ok) {
            throw new Error('Failed to fetch endpoint configurations');
        }

        const configData = await configRes.json();
        const endpoints = configData.record.endpoints || [];

        // 3. Cocokkan request path dengan slug/path endpoint yang terdaftar
        const matchedEp = endpoints.find(ep => {
            if (!ep.enabled || !ep.public) return false;
            try {
                const epUrlObj = new URL(ep.url);
                return epUrlObj.pathname === requestedPath || ep.slug === requestedPath || ('/api' + ep.slug) === requestedPath;
            } catch (e) {
                return false;
            }
        });

        if (!matchedEp) {
            return res.status(404).json({ success: false, error: `Endpoint not found or disabled for path: ${requestedPath}` });
        }

        // 4. Validasi HTTP Method
        if (matchedEp.method && matchedEp.method !== req.method) {
            return res.status(405).json({ success: false, error: `Method ${req.method} not allowed. Expected ${matchedEp.method}` });
        }

        // 5. Susun URL target sumber beserta query parameters yang dikirim pengguna
        const targetUrlObj = new URL(matchedEp.url);
        
        // Pindahkan semua query parameters dari request asli ke URL target
        const incomingUrlObj = new URL(req.url, `https://${req.headers.host}`);
        incomingUrlObj.searchParams.forEach((value, key) => {
            targetUrlObj.searchParams.set(key, value);
        });

        const targetUrl = targetUrlObj.toString();

        // 6. Validasi Keamanan SSRF (Blokir IP lokal / internal)
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

        // 7. Eksekusi Request ke API Pihak Ketiga
        const startTime = Date.now();
        const fetchOptions = {
            method: matchedEp.method || 'GET',
            headers: {
                'User-Agent': 'DIMZZ-API-HUB-Dynamic-Proxy/2026',
                ...(matchedEp.headers || {})
            }
        };

        if (['POST', 'PUT', 'PATCH'].includes(fetchOptions.method)) {
            if (req.body && Object.keys(req.body).length > 0) {
                fetchOptions.headers['Content-Type'] = 'application/json';
                fetchOptions.body = JSON.stringify(req.body);
            }
        }

        const externalRes = await fetch(targetUrl, fetchOptions);
        const responseTime = Date.now() - startTime;
        const contentType = externalRes.headers.get('content-type') || '';

        let responseData;
        if (contentType.includes('application/json')) {
            responseData = await externalRes.json();
        } else {
            responseData = await externalRes.text();
        }

        // 8. Kembalikan respons asli dari API pihak ketiga melalui domain DIMZZ
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

// Handler kompatibilitas untuk fitur tester lama
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
